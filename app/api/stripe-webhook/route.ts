import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

// Force Node runtime for raw body + Stripe SDK
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
})

// Map Price IDs (from your env) to plan & limits
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
    console.error('[WH] signature verification failed:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      // 1) Email (best effort)
      let email =
        session.customer_details?.email ||
        // (legacy fallback) some older sessions may still send this:
        (session as any).customer_email ||
        undefined

      if (!email && session.customer) {
        // final fallback: fetch the customer
        const cust = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in cust)) {
          email = cust.email ?? undefined
        }
      }

      // 2) Determine Price ID from the subscription
      let priceId: string | undefined

      if (session.mode === 'subscription' && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
          expand: ['items.data.price'], // ensure price is the full object
        })

        const firstItem = sub.items.data[0]
        // price can be a string or an object → normalize to string ID
        const p = firstItem?.price
        priceId = typeof p === 'string' ? p : p?.id
      } else if (session.mode === 'payment') {
        // single-payment mode (not your main case, but safe to keep)
        const li = (session as any).line_items?.data?.[0]
        const p = li?.price
        priceId = typeof p === 'string' ? p : p?.id
      }

      // 3) Map to plan
      const mapping = priceId ? PRICE_TO_PLAN[priceId] : undefined

      // Helpful log in Vercel (only on success path):
      console.log('[WH] session.completed → email:', email, 'priceId:', priceId, 'mapping:', mapping)

      if (!email || !mapping) {
        // Return 200 so Stripe stops retrying; we just log and exit.
        console.warn('[WH] missing email or mapping', { email, priceId })
        return NextResponse.json({ received: true }, { status: 200 })
      }

      // 4) Update Supabase
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )

      const table = process.env.SUPABASE_USERS_TABLE || 'users'
      const emailCol = process.env.SUPABASE_EMAIL_COLUMN || 'email'

      const { error } = await supabase
        .from(table)
        .update({
          plan: mapping.plan,
          daily_comp_limit: mapping.limit,
        })
        .eq(emailCol, email)

      if (error) {
        console.error('[WH] Supabase update error:', error)
        return NextResponse.json({ error: 'Supabase update failed' }, { status: 500 })
      }
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('[WH] handler error:', err)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}
