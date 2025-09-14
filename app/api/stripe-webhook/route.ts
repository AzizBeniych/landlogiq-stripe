import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs' // ensure not edge

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Map your Stripe PRICE IDs → plan/limit
const PRICE_TO_PLAN: Record<string, { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }> = {
  [process.env.PRICE_BASIC!]: { plan: 'Basic', limit: '10' },
  [process.env.PRICE_PRO!]:   { plan: 'Pro',   limit: '30' },
  [process.env.PRICE_ELITE!]: { plan: 'Elite', limit: 'unlimited' },
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  const raw = await req.text()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      // 1) Get customer email
      let email = session.customer_details?.email as string | undefined
      if (!email && session.customer) {
        const customer = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in customer)) email = customer.email ?? undefined
      }

      // 2) Get the subscription’s price id
      let priceId: string | undefined
      if (session.mode === 'subscription' && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
          expand: ['items.data.price'],
        })
        priceId = sub.items.data[0]?.price?.id
      }

      const mapping = priceId ? PRICE_TO_PLAN[priceId] : undefined
      if (!email || !mapping) {
        console.warn('Missing email or plan mapping', { email, priceId })
        return NextResponse.json({ received: true }, { status: 200 })
      }

      // 3) Upsert into dedicated billing table (creates row if none)
      const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
      const table = process.env.SUPABASE_USERS_TABLE || 'billing_users'
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
    return NextResponse.json({ error: 'Internal webhook error' }, { status: 500 })
  }
}

// Keep raw body for Stripe signature
export const config = { api: { bodyParser: false } }
