// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs' // important for raw body + signature verification

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// You can set ENV values to either a price_... OR a prod_...
const ENV_IDS = {
  Basic: process.env.PRICE_BASIC!, // may be price_... OR prod_...
  Pro: process.env.PRICE_PRO!,
  Elite: process.env.PRICE_ELITE!,
}

type PlanInfo = { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }

// Resolve plan using either a priceId or productId
function resolvePlan(priceId?: string, productId?: string): PlanInfo | undefined {
  const entries = Object.entries(ENV_IDS) as Array<[keyof typeof ENV_IDS, string]>
  for (const [label, id] of entries) {
    // price match
    if (id?.startsWith('price_') && priceId && id === priceId) {
      if (label === 'Basic') return { plan: 'Basic', limit: '10' }
      if (label === 'Pro') return { plan: 'Pro', limit: '30' }
      if (label === 'Elite') return { plan: 'Elite', limit: 'unlimited' }
    }
    // product match
    if (id?.startsWith('prod_') && productId && id === productId) {
      if (label === 'Basic') return { plan: 'Basic', limit: '10' }
      if (label === 'Pro') return { plan: 'Pro', limit: '30' }
      if (label === 'Elite') return { plan: 'Elite', limit: 'unlimited' }
    }
  }
  return undefined
}

export async function POST(req: NextRequest) {
  // 1) Verify signature with raw body
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  const rawBody = await req.text()
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err: any) {
    console.error('Stripe signature error:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      // 2) Best-effort email extraction
      let email: string | undefined =
        session.customer_details?.email ||
        // Some older sessions still send this:
        (session as any).customer_email ||
        undefined

      if (!email && session.customer) {
        // Fetch the Customer if we still don't have an email
        const cust = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in cust) && cust.email) email = cust.email
      }

      // 3) Pull both price and product from the subscription (subscription mode)
      let priceId: string | undefined
      let productId: string | undefined

      if (session.mode === 'subscription' && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
          expand: ['items.data.price.product'],
        })
        const item = sub.items.data[0]
        priceId = item?.price?.id
        const prod = item?.price?.product as string | Stripe.Product | undefined
        productId = typeof prod === 'string' ? prod : prod?.id
      }

      // 4) Determine plan mapping
      const mapping = resolvePlan(priceId, productId)
      if (!email || !mapping) {
        console.warn('Missing email or mapping', { email, priceId, productId })
        // Always return 200 so Stripe stops retrying on our side
        return NextResponse.json({ received: true }, { status: 200 })
      }

      // 5) Write to Supabase with UPSERT (create-or-update by email)
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )

      const emailCol = process.env.SUPABASE_EMAIL_COLUMN || 'email'
      const table = process.env.SUPABASE_USERS_TABLE || 'users'

      const { error } = await supabase
        .from(table)
        .upsert(
          {
            [emailCol]: email,
            plan: mapping.plan,
            daily_comp_limit: mapping.limit,
          },
          { onConflict: emailCol } // unique/idx on email recommended
        )

      if (error) {
        console.error('Supabase upsert failed', error)
        return NextResponse.json({ error: 'Supabase upsert failed' }, { status: 500 })
      }
    }

    // Always 200 on handled events
    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('Webhook handler error', err)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}
