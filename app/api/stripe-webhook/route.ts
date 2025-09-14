// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs' // force Node runtime (not edge)

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Map Stripe Price IDs -> plan + comp limit
const PRICE_TO_PLAN: Record<string, { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }> = {
  [process.env.PRICE_BASIC!]: { plan: 'Basic', limit: '10' },
  [process.env.PRICE_PRO!]:   { plan: 'Pro',   limit: '30' },
  [process.env.PRICE_ELITE!]: { plan: 'Elite', limit: 'unlimited' },
}

function env(name: string) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  const raw = await req.text()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(raw, sig, env('STRIPE_WEBHOOK_SECRET'))
  } catch (err: any) {
    console.error('[WH] bad signature:', err?.message)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    if (event.type !== 'checkout.session.completed') {
      console.info(`[WH] ignoring ${event.type}`)
      return NextResponse.json({ received: true }, { status: 200 })
    }

    const session = event.data.object as Stripe.Checkout.Session

    // --- Resolve email robustly ---
    let email =
      session.customer_details?.email ??
      (session as any).customer_email ??
      undefined

    if (!email && session.customer) {
      try {
        const cust = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in cust)) email = cust.email ?? undefined
      } catch (e) {
        console.warn('[WH] could not retrieve customer:', e)
      }
    }

    // --- Resolve priceId robustly ---
    let priceId: string | undefined
    if (session.mode === 'subscription' && session.subscription) {
      const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
        expand: ['items.data.price'],
      })
      priceId = sub.items.data[0]?.price?.id
    } else if ((session as any).line_items) {
      priceId = (session as any).line_items?.data?.[0]?.price?.id
    }

    const mapping = priceId ? PRICE_TO_PLAN[priceId] : undefined
    console.info('[WH] resolved =>', { email, priceId, mapping })

    if (!email || !mapping) {
      console.warn('[WH] missing email or mapping', { email, priceId })
      return NextResponse.json({ received: true }, { status: 200 })
    }

    const table = process.env.SUPABASE_USERS_TABLE || 'users'
    const emailCol = process.env.SUPABASE_EMAIL_COLUMN || 'email'

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))

    const { data, error } = await supabase
      .from(table)
      .update({ plan: mapping.plan, daily_comp_limit: mapping.limit })
      .eq(emailCol, email)
      .select() // so we can see how many rows were updated

    if (error) {
      console.error('[WH] supabase error:', error)
      return NextResponse.json({ error: 'Supabase update failed' }, { status: 500 })
    }

    console.info('[WH] supabase updated rows:', data?.length ?? 0)
    return NextResponse.json({ received: true, updated: data?.length ?? 0 }, { status: 200 })
  } catch (err: any) {
    console.error('[WH] handler error:', err)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}
