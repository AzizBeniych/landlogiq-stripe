// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs' // use Node runtime for Stripe SDK

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Map the client’s Price IDs -> plan + daily limits
const PRICE_TO_PLAN: Record<string, { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }> = {
  [process.env.PRICE_BASIC!]: { plan: 'Basic', limit: '10' },
  [process.env.PRICE_PRO!]:   { plan: 'Pro',   limit: '30' },
  [process.env.PRICE_ELITE!]: { plan: 'Elite', limit: 'unlimited' },
}

async function resolveEmailAndPrice(session: Stripe.Checkout.Session) {
  // Start with the email Stripe gives us on the session
  let email = session.customer_details?.email || undefined

  // Prefer subscription item price for subscriptions
  let priceId: string | undefined
  if (session.mode === 'subscription' && session.subscription) {
    const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
      expand: ['items.data.price'],
    })
    priceId = sub.items.data[0]?.price?.id

    // If email was missing, try fetching the customer
    if (!email && typeof session.customer === 'string') {
      const cust = await stripe.customers.retrieve(session.customer)
      if (!('deleted' in cust)) email = cust.email ?? undefined
    }
  } else {
    // Fallback (rare): expand line_items on the session to find the price
    const s = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items.data.price'],
    })
    const li = s.line_items?.data?.[0]
    priceId = (li?.price as Stripe.Price | undefined)?.id
    if (!email && s.customer_details?.email) email = s.customer_details.email
  }

  return { email, priceId }
}

export async function POST(req: NextRequest) {
  // Stripe signature header
  const signature = req.headers.get('stripe-signature')
  if (!signature) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  // Raw body for verification
  const rawBody = await req.text()

  // Verify signature
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (e: any) {
    console.error('❌ Bad signature:', e?.message)
    return NextResponse.json({ error: `Webhook Error: ${e.message}` }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      const { email, priceId } = await resolveEmailAndPrice(session)
      const mapping = priceId ? PRICE_TO_PLAN[priceId] : undefined

      if (!email || !mapping) {
        console.warn('⚠️ Missing email or price mapping', { email, priceId })
        // Return 200 so Stripe stops retrying; we just skip the update.
        return NextResponse.json({ received: true }, { status: 200 })
      }

      // Update the existing user row (no upsert => no NOT NULL issues)
      const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
      const { error } = await supabase
        .from(process.env.SUPABASE_USERS_TABLE || 'users')
        .update({
          plan: mapping.plan,
          daily_comp_limit: mapping.limit,
        })
        .eq(process.env.SUPABASE_EMAIL_COLUMN || 'email', email)

      if (error) {
        console.error('❌ Supabase update error:', error)
        return NextResponse.json({ error: 'Supabase update failed' }, { status: 500 })
      }

      console.log('✅ Updated user', { email, plan: mapping.plan })
    }

    // Always 200 so Stripe doesn’t retry for other events we ignore
    return NextResponse.json({ received: true }, { status: 200 })
  } catch (e: any) {
    console.error('❌ Handler error:', e)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}
