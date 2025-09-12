import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

const PRICE_TO_PLAN: Record<string, { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }> = {
  [process.env.PRICE_BASIC!]: { plan: 'Basic', limit: '10' },
  [process.env.PRICE_PRO!]:   { plan: 'Pro',   limit: '30' },
  [process.env.PRICE_ELITE!]: { plan: 'Elite', limit: 'unlimited' },
}

export const runtime = 'nodejs' // ensure edge is not used

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!
  const body = await req.text() // raw body for signature check

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
      const email = session.customer_details?.email

      let priceId: string | undefined
      if (session.mode === 'subscription' && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string)
        priceId = sub.items.data[0]?.price?.id
      }

      const mapping = priceId ? PRICE_TO_PLAN[priceId] : undefined
      if (!email || !mapping) {
        console.warn('Missing email or price mapping', { email, priceId })
        return NextResponse.json({ received: true, note: 'Missing email or mapping' }, { status: 200 })
      }

      const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

      const { error } = await supabase
        .from(process.env.SUPABASE_USERS_TABLE || 'users')
        .update({
          plan: mapping.plan,
          daily_comp_limit: mapping.limit,
        })
        .eq(process.env.SUPABASE_EMAIL_COLUMN || 'email', email)

      if (error) {
        console.error('Supabase update error', error)
        return NextResponse.json({ error: 'Supabase update failed' }, { status: 500 })
      }
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('Webhook handler error', err)
    return NextResponse.json({ error: 'Internal webhook error' }, { status: 500 })
  }
}
