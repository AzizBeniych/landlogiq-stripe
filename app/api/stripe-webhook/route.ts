import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Map your Stripe Price IDs to plans/limits
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
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err: any) {
    console.error('[WH] signature fail:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  console.log('[WH] event:', event.type)

  if (event.type !== 'checkout.session.completed') {
    return NextResponse.json({ received: true }, { status: 200 })
  }

  try {
    const session = event.data.object as Stripe.Checkout.Session

    // 1) Get email (with fallback to fetching the customer)
    let email: string | null =
      session.customer_details?.email ?? null

    if (!email && session.customer) {
      try {
        const c = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in c)) email = c.email ?? null
      } catch (e: any) {
        console.warn('[WH] fetch customer failed:', e?.message)
      }
    }

    // 2) Get the active price id
    let priceId: string | undefined
    if (session.mode === 'subscription' && session.subscription) {
      const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
        expand: ['items.data.price'],
      })
      priceId = sub.items.data[0]?.price?.id
    }

    console.log('[WH] email:', email, 'priceId:', priceId)

    const mapping = priceId ? PRICE_TO_PLAN[priceId] : undefined
    if (!email || !mapping) {
      console.warn('[WH] missing email or mapping', { email, priceId, sessionId: session.id })
      // Return 200 so Stripe stops retrying; we’ve logged the reason.
      return NextResponse.json({ received: true }, { status: 200 })
    }

    // 3) Upsert into Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const table = process.env.SUPABASE_USERS_TABLE || 'users'
    const emailCol = process.env.SUPABASE_EMAIL_COLUMN || 'email'

    const { data, error } = await supabase
      .from(table)
      .upsert(
        { [emailCol]: email, plan: mapping.plan, daily_comp_limit: mapping.limit },
        { onConflict: emailCol }
      )
      .select()

    if (error) {
      console.error('[WH] Supabase error:', error)
      return NextResponse.json({ error: 'Supabase upsert failed' }, { status: 500 })
    }

    console.log('[WH] Supabase upsert OK:', data)
    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('[WH] handler error:', err?.message, err)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}
