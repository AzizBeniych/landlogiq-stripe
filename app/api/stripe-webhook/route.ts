// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs' // important on Vercel

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

type PlanInfo = { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }

const PRICE_TO_PLAN: Record<string, PlanInfo> = {
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
    console.error('WH ERR signature', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      // 1) Get the customer email (fallback to retrieving Customer if needed)
      let email: string | undefined = session.customer_details?.email || undefined
      if (!email && session.customer) {
        const cust = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in cust)) email = cust.email || undefined
      }
      if (email) email = email.toLowerCase()

      // 2) Get the price id from the subscription
      let priceId: string | undefined
      if (session.mode === 'subscription' && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
          expand: ['items.data.price'],
        })
        priceId = sub.items.data[0]?.price?.id
      }

      const mapping = priceId ? PRICE_TO_PLAN[priceId] : undefined
      console.log('WH DEBUG', { email, priceId, mapping })

      if (!email || !mapping) {
        // Return 200 so Stripe stops retrying, but log why.
        console.warn('WH NOTE missing email or mapping', { email, priceId })
        return NextResponse.json({ received: true }, { status: 200 })
      }

      // 3) Upsert (create if missing, update if exists) by email (case-insensitive unique)
      const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
      const table = process.env.SUPABASE_USERS_TABLE || 'users'
      const emailCol = process.env.SUPABASE_EMAIL_COLUMN || 'email'

      const { error } = await supabase
        .from(table)
        .upsert(
          { [emailCol]: email, plan: mapping.plan, daily_comp_limit: mapping.limit },
          { onConflict: emailCol } // requires a unique index on that column
        )

      if (error) {
        console.error('WH ERR supabase', error)
        return NextResponse.json({ error: 'Supabase upsert failed' }, { status: 500 })
      }

      console.log('WH OK updated', { email, plan: mapping.plan, limit: mapping.limit })
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('WH ERR handler', err)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}
