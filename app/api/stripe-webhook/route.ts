// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Env IDs may be price_... OR prod_...
const ENV_IDS = {
  Basic: process.env.PRICE_BASIC!,
  Pro: process.env.PRICE_PRO!,
  Elite: process.env.PRICE_ELITE!,
}

type PlanInfo = { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }

function resolvePlan(priceId?: string, productId?: string): PlanInfo | undefined {
  const entries: Array<[keyof typeof ENV_IDS, string]> = Object.entries(ENV_IDS) as any
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

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!
  const body = await req.text()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret)
  } catch (err: any) {
    console.error('Webhook signature verification failed', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      const email = session.customer_details?.email || undefined

      // fetch subscription to get both price and product IDs
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
        console.warn('Missing email or mapping', { email, priceId, productId })
        return NextResponse.json({ received: true, note: 'Missing email or mapping' }, { status: 200 })
      }

      const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

      const { error } = await supabase
        .from(process.env.SUPABASE_USERS_TABLE || 'users')
        .upsert(
          {
            [process.env.SUPABASE_EMAIL_COLUMN || 'email']: email,
            plan: mapping.plan,
            daily_comp_limit: mapping.limit,
          },
          { onConflict: process.env.SUPABASE_EMAIL_COLUMN || 'email' }
        )

      if (error) {
        console.error('Supabase upsert error', error)
        return NextResponse.json({ error: 'Supabase upsert failed' }, { status: 500 })
      }
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } cat
