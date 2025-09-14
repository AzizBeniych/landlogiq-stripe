// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

// App Router: keep this on Node runtime and avoid caching
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Price-ID → plan mapping (from env)
const PRICE_TO_PLAN: Record<string, { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }> = {
  [process.env.PRICE_BASIC!]: { plan: 'Basic', limit: '10' },
  [process.env.PRICE_PRO!]:   { plan: 'Pro',   limit: '30' },
  [process.env.PRICE_ELITE!]: { plan: 'Elite', limit: 'unlimited' },
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  // IMPORTANT: raw body for Stripe signature verification
  const raw = await req.text()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (e: any) {
    console.error('[WH] signature error:', e?.message)
    return NextResponse.json({ error: `Webhook Error: ${e.message}` }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      // Get email (robustly)
      let email =
        session.customer_details?.email ||
        (session as any).customer_email ||
        undefined
      if (!email && session.customer) {
        const c = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in c)) email = c.email ?? undefined
      }

      // Get priceId from the subscription, with fallbacks
      let priceId: string | undefined

      if (session.mode === 'subscription' && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
          expand: ['items.data.price'],
        })
        priceId = sub.items.data[0]?.price?.id
      }
      if (!priceId) {
        const s = await stripe.checkout.sessions.retrieve(session.id, {
          expand: ['line_items.data.price'],
        })
        priceId = s.line_items?.data?.[0]?.price?.id
      }

      const mapping = priceId ? PRICE_TO_PLAN[priceId] : undefined
      if (!email || !mapping) {
        console.warn('[WH] missing email or mapping', { email, priceId })
        return NextResponse.json({ received: true }, { status: 200 })
      }

      // Update Supabase row by email
      const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
      const { error } = await supabase
        .from(process.env.SUPABASE_USERS_TABLE || 'users')
        .update({ plan: mapping.plan, daily_comp_limit: mapping.limit })
        .eq(process.env.SUPABASE_EMAIL_COLUMN || 'email', email)

      if (error) {
        console.error('[WH] Supabase update error', error)
        return NextResponse.json({ error: 'Supabase update failed' }, { status: 500 })
      }
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (e: any) {
    console.error('[WH] handler error', e)
    return NextResponse.json({ error: 'Internal webhook error' }, { status: 500 })
  }
}
