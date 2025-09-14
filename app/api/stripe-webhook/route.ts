// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs' // ensure Node runtime (not edge) for raw body access

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
})

/**
 * Map your Prices (or Products) to plan + limit.
 * Prefer using Price IDs (price_...) from Stripe, but this also supports prod_... if needed.
 */
const ENV_IDS = {
  Basic: process.env.PRICE_BASIC!, // e.g. price_XXXX
  Pro: process.env.PRICE_PRO!,     // e.g. price_YYYY
  Elite: process.env.PRICE_ELITE!, // e.g. price_ZZZZ
}

type PlanInfo = { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }

function resolvePlan(priceId?: string, productId?: string): PlanInfo | undefined {
  // Check explicit price matches first
  if (priceId) {
    if (priceId === ENV_IDS.Basic) return { plan: 'Basic', limit: '10' }
    if (priceId === ENV_IDS.Pro)   return { plan: 'Pro',   limit: '30' }
    if (priceId === ENV_IDS.Elite) return { plan: 'Elite', limit: 'unlimited' }
  }

  // Optional product fallback if you ever supply prod_... instead of price_...
  if (productId) {
    if (productId === ENV_IDS.Basic) return { plan: 'Basic', limit: '10' }
    if (productId === ENV_IDS.Pro)   return { plan: 'Pro',   limit: '30' }
    if (productId === ENV_IDS.Elite) return { plan: 'Elite', limit: 'unlimited' }
  }

  return undefined
}

async function getEmailFromSession(session: Stripe.Checkout.Session): Promise<string | undefined> {
  // 1) Normal place for the email:
  if (session.customer_details?.email) return session.customer_details.email

  // 2) Legacy/older field sometimes present:
  // @ts-expect-error: legacy field occasionally exists on some sessions
  if (session.customer_email && typeof session.customer_email === 'string') {
    // @ts-ignore
    return session.customer_email as string
  }

  // 3) As a final fallback, fetch the Stripe customer record
  if (session.customer) {
    const cust = await stripe.customers.retrieve(session.customer as string)
    if (!('deleted' in cust) && cust.email) return cust.email
  }

  return undefined
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  const rawBody = await req.text()
  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    // We only need to act on successful checkout completion to tag the user.
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      const email = await getEmailFromSession(session)

      // Identify the subscribed price/product
      let priceId: string | undefined
      let productId: string | undefined

      if (session.mode === 'subscription' && session.subscription) {
        // Expand subscription items to read price + product
        const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
          expand: ['items.data.price.product'],
        })
        const item = sub.items.data[0]
        priceId = item?.price?.id

        const prod = item?.price?.product as string | Stripe.Product | undefined
        productId = typeof prod === 'string' ? prod : prod?.id
      }

      const mapping = resolvePlan(priceId, productId)

      if (!email || !mapping) {
        console.warn('Stripe webhook: missing email or plan mapping', { email, priceId, productId })
        // Always return 200 so Stripe stops retrying; we just log for visibility.
        return NextResponse.json({ received: true, note: 'missing email or mapping' }, { status: 200 })
      }

      // Supabase (Service Role bypasses RLS)
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )

      const table = process.env.SUPABASE_USERS_TABLE || 'users'
      const emailCol = process.env.SUPABASE_EMAIL_COLUMN || 'email'

      // IMPORTANT: UPDATE by email (no upsert) to avoid NOT NULL password_hash issue.
      const { data, error } = await supabase
        .from(table)
        .update({
          plan: mapping.plan,
          daily_comp_limit: mapping.limit,
        })
        .eq(emailCol, email)
        .select(emailCol) // returns [] if no match

      if (error) {
        console.error('Supabase UPDATE failed:', error)
        return NextResponse.json({ error: 'Supabase update failed' }, { status: 500 })
      }

      if (!data?.length) {
        // Row didn’t exist; that’s OK (we’re not inserting by design).
        console.warn('Supabase UPDATE: no row matched this email; nothing updated', { table, emailCol, email })
      }
    }

    // Acknowledge all events (including the ones we ignore) so Stripe doesn’t retry.
    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('Webhook handler error:', err)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}

// For older Next runtimes, this ensures raw body is preserved.
// Safe to keep even in App Router.
export const config = {
  api: { bodyParser: false },
}
