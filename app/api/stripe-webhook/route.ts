// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs' // keep Node runtime (not edge)

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })
const DEBUG = process.env.WH_DEBUG === '1'

// Map Stripe price IDs to plan/limit
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
    console.error('[WH] signature error:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    if (DEBUG) console.log('[WH] event type:', event.type)

    if (event.type !== 'checkout.session.completed') {
      if (DEBUG) console.log('[WH] ignored:', event.type)
      return NextResponse.json({ ok: true, ignored: event.type }, { status: 200 })
    }

    const session = event.data.object as Stripe.Checkout.Session

    // 1) Email
    let email: string | undefined =
      session.customer_details?.email ||
      (session as any).customer_email ||
      undefined

    if (!email && session.customer) {
      const cust = await stripe.customers.retrieve(session.customer as string)
      if (!('deleted' in cust) && cust.email) email = cust.email
    }

    // 2) Price ID (subscription)
    let priceId: string | undefined
    if (session.mode === 'subscription' && session.subscription) {
      const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
        expand: ['items.data.price'],
      })
      priceId = sub.items.data[0]?.price?.id
    }

    if (DEBUG) console.log('[WH] email/price:', { email, priceId })

    // 3) Mapping
    const mapping = priceId ? PRICE_TO_PLAN[priceId] : undefined
    if (!email || !mapping) {
      console.warn('[WH] missing email or price mapping', { email, priceId, PRICE_TO_PLAN })
      return NextResponse.json({ ok: true, note: 'missing email/mapping' }, { status: 200 })
    }

    // 4) Upsert to Supabase
    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const table = process.env.SUPABASE_USERS_TABLE || 'users'
    const emailCol = process.env.SUPABASE_EMAIL_COLUMN || 'email'

    const payload = { [emailCol]: email, plan: mapping.plan, daily_comp_limit: mapping.limit }

    const { data, error } = await supabase
      .from(table)
      .upsert(payload, { onConflict: emailCol })
      .select() // return affected rows so we can log

    if (error) {
      console.error('[WH] supabase upsert error:', error)
      return NextResponse.json({ error: 'Supabase upsert failed' }, { status: 500 })
    }

    if (DEBUG) console.log('[WH] upsert ok:', { table, email, plan: mapping.plan, rows: data?.length, row: data?.[0] })

    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err: any) {
    console.error('[WH] handler error:', err)
    return NextResponse.json({ error: 'Internal webhook error' }, { status: 500 })
  }
}
