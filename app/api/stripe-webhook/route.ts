// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Allow env to be price_... OR prod_...
const ENV_IDS = {
  Basic: process.env.PRICE_BASIC!,
  Pro:   process.env.PRICE_PRO!,
  Elite: process.env.PRICE_ELITE!,
}

type PlanInfo = { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }

function resolvePlan(priceId?: string, productId?: string): PlanInfo | undefined {
  const entries = Object.entries(ENV_IDS) as Array<[keyof typeof ENV_IDS, string]>
  for (const [label, id] of entries) {
    if (id?.startsWith('price_') && priceId && id === priceId) {
      if (label === 'Basic') return { plan: 'Basic', limit: '10' }
      if (label === 'Pro')   return { plan: 'Pro',   limit: '30' }
      if (label === 'Elite') return { plan: 'Elite', limit: 'unlimited' }
    }
    if (id?.startsWith('prod_') && productId && id === productId) {
      if (label === 'Basic') return { plan: 'Basic', limit: '10' }
      if (label === 'Pro')   return { plan: 'Pro',   limit: '30' }
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
    console.error('Webhook signature error:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      // --- 1) Robust email resolution
      let email: string | undefined =
        session.customer_details?.email ||
        (session as any).customer_email || // legacy field sometimes present
        undefined

      if (!email && session.customer) {
        const cust = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in cust)) email = cust.email ?? undefined
      }

      // --- 2) Get priceId/productId from the subscription
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

      // Collect Stripe IDs for auditing
      const stripeCustomerId =
        typeof session.customer === 'string'
          ? session.customer
          : (session.customer as any)?.id

      const stripeSubscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : (session.subscription as any)?.id

      // If we don't have enough to map a plan, still upsert the stripe identifiers (optional)
      if (!email) {
        console.warn('[WH] missing email; cannot upsert by email', { stripeCustomerId })
        return NextResponse.json({ received: true }, { status: 200 })
      }

      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )

      const TABLE = process.env.SUPABASE_USERS_TABLE || 'billing_users'
      const EMAIL_COL = process.env.SUPABASE_EMAIL_COLUMN || 'email'

      // --- 3) UPSERT by email (create if missing, update if exists)
      const upsertRow: Record<string, any> = {
        [EMAIL_COL]: email,
        stripe_customer_id: stripeCustomerId ?? null,
        stripe_subscription_id: stripeSubscriptionId ?? null,
        last_checkout_session_id: session.id,
      }

      if (mapping) {
        upsertRow.plan = mapping.plan
        upsertRow.daily_comp_limit = mapping.limit
      }

      const { error } = await supabase
        .from(TABLE)
        .upsert(upsertRow, { onConflict: EMAIL_COL })

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
