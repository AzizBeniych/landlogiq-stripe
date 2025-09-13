// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Map your Test (or Live) Price IDs to plans
const PRICE_TO_PLAN: Record<string, { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }> = {
  [process.env.PRICE_BASIC!]: { plan: 'Basic', limit: '10' },
  [process.env.PRICE_PRO!]:   { plan: 'Pro',   limit: '30' },
  [process.env.PRICE_ELITE!]: { plan: 'Elite', limit: 'unlimited' },
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

      // ---- 1) Get customer email robustly ----
      let email =
        session.customer_details?.email ||
        // older/alternate field Stripe sometimes keeps:
        (session as any).customer_email ||
        undefined

      if (!email && session.customer) {
        const cust = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in cust) && cust.email) email = cust.email
      }

      // ---- 2) Get the price ID from the subscription ----
      let priceId: string | undefined
      if (session.mode === 'subscription' && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
          expand: ['items.data.price'],
        })
        priceId = sub.items.data[0]?.price?.id
      }

      const mapped = priceId ? PRICE_TO_PLAN[priceId] : undefined

      if (!email || !mapped) {
        console.warn('Webhook missing email or price mapping', { email, priceId })
        // Return 200 so Stripe stops retrying (we logged the problem)
        return NextResponse.json({ received: true }, { status: 200 })
      }

      // ---- 3) Update Supabase user by email ----
      const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

      const { error } = await supabase
        .from(process.env.SUPABASE_USERS_TABLE || 'users')
        .update({
          plan: mapped.plan,
          daily_comp_limit: mapped.limit,
        })
        .eq(process.env.SUPABASE_EMAIL_COLUMN || 'email', email)

      if (error) {
        console.error('Supabase update error:', error)
        return NextResponse.json({ error: 'Supabase update failed' }, { status: 500 })
      }

      console.log('WEBHOOK OK:', { email, priceId, plan: mapped.plan })
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('Webhook handler crash:', err)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}
