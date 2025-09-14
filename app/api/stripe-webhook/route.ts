// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// map your env PRICE_* to plan + limit
const PRICE_TO_PLAN: Record<string, { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }> = {
  [process.env.PRICE_BASIC!]: { plan: 'Basic', limit: '10' },
  [process.env.PRICE_PRO!]:   { plan: 'Pro',   limit: '30' },
  [process.env.PRICE_ELITE!]: { plan: 'Elite', limit: 'unlimited' },
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  let event: Stripe.Event
  const raw = await req.text() // raw body is required
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err: any) {
    console.error('Webhook signature fail:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      // always get an email
      let email = session.customer_details?.email || (session as any).customer_email || undefined
      if (!email && session.customer) {
        const cust = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in cust)) email = cust.email || undefined
      }

      // get the price id from the subscription
      let priceId: string | undefined
      if (session.mode === 'subscription' && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
          expand: ['items.data.price'],
        })
        priceId = sub.items.data[0]?.price?.id
      }

      const mapping = priceId ? PRICE_TO_PLAN[priceId] : undefined
      console.log('WH DEBUG →', { email, priceId, mapping })

      if (!email || !mapping) {
        // return 200 so Stripe stops retrying
        return NextResponse.json({ received: true, note: 'missing email or mapping' }, { status: 200 })
      }

      const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
      const TABLE = process.env.SUPABASE_USERS_TABLE || 'users'
      const EMAIL_COL = process.env.SUPABASE_EMAIL_COLUMN || 'email'

      // UPSERT makes it bullet-proof (update existing row OR insert new)
      const payload = {
        [EMAIL_COL]: email,
        plan: mapping.plan,
        daily_comp_limit: mapping.limit,
        updated_at: new Date().toISOString(),
      }

      const { error } = await supabase
        .from(TABLE)
        .upsert(payload, { onConflict: EMAIL_COL })

      if (error) {
        console.error('Supabase upsert error', error)
        return NextResponse.json({ error: 'Supabase upsert failed' }, { status: 500 })
      }
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('Webhook handler error:', err?.message)
    return NextResponse.json({ error: 'Internal webhook error' }, { status: 500 })
  }
}
