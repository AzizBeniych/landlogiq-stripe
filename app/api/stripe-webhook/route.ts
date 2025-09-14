// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

const ENV_IDS = {
  Basic: process.env.PRICE_BASIC!,
  Pro: process.env.PRICE_PRO!,
  Elite: process.env.PRICE_ELITE!,
}
type PlanInfo = { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }

function resolvePlan(priceId?: string, productId?: string): PlanInfo | undefined {
  const entries = Object.entries(ENV_IDS) as Array<[keyof typeof ENV_IDS, string]>
  for (const [label, id] of entries) {
    // allow either price_... or prod_... in env
    if (id?.startsWith('price_') && priceId && id === priceId) {
      if (label === 'Basic') return { plan: 'Basic', limit: '10' }
      if (label === 'Pro') return { plan: 'Pro', limit: '30' }
      if (label === 'Elite') return { plan: 'Elite', limit: 'unlimited' }
    }
    if (id?.startsWith('prod_') && productId && id === productId) {
      if (label === 'Basic') return { plan: 'Basic', limit: '10' }
      if (label === 'Pro') return { plan: 'Pro', limit: '30' }
      if (label === 'Elite') return { plan: 'Elite', limit: 'unlimited' }
    }
  }
  return undefined
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  const rawBody = await req.text()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err: any) {
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      // ---- 1) EMAIL (robust)
      let email =
        session.customer_details?.email ||
        (session as any).customer_email ||
        undefined
      if (!email && session.customer) {
        const cust = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in cust) && cust.email) email = cust.email
      }

      // ---- 2) PLAN (price/product)
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

      const mapping = resolvePlan(priceId, productId)

      console.log('WH DEBUG →', { email, priceId, productId, mapping })

      if (!email || !mapping) {
        // Return 200 so Stripe stops retrying; just log for you to inspect
        console.warn('Missing email or plan mapping', { email, priceId, productId })
        return NextResponse.json({ received: true }, { status: 200 })
      }

      const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
      const EMAIL_COL = process.env.SUPABASE_EMAIL_COLUMN || 'email'
      const TABLE = process.env.SUPABASE_USERS_TABLE || 'users'

      // ---- 3) UPSERT (idempotent)
      const { data, error } = await supabase
        .from(TABLE)
        .upsert(
          {
            [EMAIL_COL]: email.toLowerCase(),  // normalize casing
            plan: mapping.plan,
            daily_comp_limit: mapping.limit,
          },
          { onConflict: EMAIL_COL }
        )
        .select()

      if (error) {
        console.error('Supabase upsert failed', error)
        return NextResponse.json({ error: 'Supabase upsert failed' }, { status: 500 })
      }

      console.log('WH DEBUG → upsert ok', data)
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('Webhook handler error', err)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}
