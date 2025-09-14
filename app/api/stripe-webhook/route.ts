// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs' // keep this Node, not Edge
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Accept either price IDs or product IDs in env, map to plan/limit
const ENV_IDS = {
  Basic: process.env.PRICE_BASIC!,
  Pro: process.env.PRICE_PRO!,
  Elite: process.env.PRICE_ELITE!,
}
type PlanInfo = { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }

function resolvePlan(priceId?: string, productId?: string): PlanInfo | undefined {
  const entries = Object.entries(ENV_IDS) as Array<[keyof typeof ENV_IDS, string]>
  for (const [label, id] of entries) {
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
    console.error('Webhook signature verification failed:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      // 1) Get email robustly
      let email = session.customer_details?.email || undefined
      if (!email && (session as any).customer_email) {
        email = (session as any).customer_email as string
      }
      if (!email && session.customer) {
        const cust = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in cust)) email = cust.email || undefined
      }

      // 2) Get priceId/productId from the subscription
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
      if (!email || !mapping) {
        console.warn('WH: missing email or mapping', { email, priceId, productId })
        // Return 200 so Stripe stops retrying; we just log and exit.
        return NextResponse.json({ received: true }, { status: 200 })
      }

      // 3) Upsert (create if missing, update if exists)
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )

      const table = process.env.SUPABASE_USERS_TABLE || 'users'
      const emailCol = process.env.SUPABASE_EMAIL_COLUMN || 'email'

      const { error } = await supabase
        .from(table)
        .upsert(
          {
            [emailCol]: email,
            plan: mapping.plan,
            daily_comp_limit: mapping.limit,
          },
          { onConflict: emailCol }
        )

      if (error) {
        console.error('Supabase upsert error:', error)
        return NextResponse.json({ error: 'Supabase upsert failed' }, { status: 500 })
      }
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('Webhook handler error:', err)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}
