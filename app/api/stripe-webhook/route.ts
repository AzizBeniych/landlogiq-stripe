// app/api/stripe-webhook/route.ts
import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
})

// Map Price IDs → plan/limit (use the EXACT price IDs from Vercel env)
const PRICE_TO_PLAN: Record<string, { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }> = {
  [process.env.PRICE_BASIC!]: { plan: 'Basic', limit: '10' },
  [process.env.PRICE_PRO!]:   { plan: 'Pro',   limit: '30' },
  [process.env.PRICE_ELITE!]: { plan: 'Elite', limit: 'unlimited' },
}

// optional helper if you later want to support product fallback
function fromIds(priceId?: string | null, productId?: string | null) {
  if (priceId && PRICE_TO_PLAN[priceId]) return PRICE_TO_PLAN[priceId]
  return undefined
}

export async function POST(req: Request) {
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
    console.error('Webhook signature failed:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    // Handle the events that happen on/after checkout
    // (checkout.session.completed is enough for your flow, but we also handle the common follow-ups)
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'invoice.payment_succeeded'
    ) {
      const obj: any = event.data.object

      // 1) Get customer email (with fallbacks)
      let email: string | undefined =
        obj?.customer_details?.email ||
        obj?.customer_email ||
        undefined

      if (!email && obj?.customer) {
        // last resort: fetch the customer
        const cust = await stripe.customers.retrieve(obj.customer as string)
        if (!('deleted' in cust) && cust.email) email = cust.email
      }

      // 2) Determine the price (and optionally product) being paid for
      let priceId: string | undefined
      let productId: string | undefined

      if (obj?.subscription) {
        // checkout.session.completed / sub events
        const sub = await stripe.subscriptions.retrieve(obj.subscription as string, {
          expand: ['items.data.price.product'],
        })
        const item = sub.items.data[0]
        priceId = item?.price?.id
        const p = item?.price?.product
        productId = typeof p === 'string' ? p : p?.id
      } else if (obj?.lines?.data?.length) {
        // invoices have lines
        const item = obj.lines.data[0]
        priceId = item?.price?.id
        const p = item?.price?.product
        productId = typeof p === 'string' ? p : p?.id
      }

      const mapping = fromIds(priceId, productId)

      if (!email || !mapping) {
        console.log('WH: missing email or mapping', { email, priceId, productId, type: event.type })
        return NextResponse.json({ received: true })
      }

      // 3) Upsert into Supabase (create if not exists, otherwise update)
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )

      const table = process.env.SUPABASE_USERS_TABLE || 'users'
      const emailCol = process.env.SUPABASE_EMAIL_COLUMN || 'email'

      const { error } = await supabase
        .from(table)
        .upsert(
          {
            [emailCol]: email,
            plan: mapping.plan,
            daily_comp_limit: mapping.limit,
          },
          { onConflict: emailCol } // requires a unique index on the email column
        )

      if (error) {
        console.error('Supabase upsert error:', error)
        return NextResponse.json({ error: 'Supabase upsert failed' }, { status: 500 })
      }

      console.log('WH: upserted', { email, plan: mapping.plan, limit: mapping.limit })
    }

    return NextResponse.json({ received: true })
  } catch (err: any) {
    console.error('Webhook handler error:', err)
    return NextResponse.json({ error: 'Internal webhook error' }, { status: 500 })
  }
}
