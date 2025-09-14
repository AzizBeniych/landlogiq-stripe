// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Map Price IDs -> plan & limits
const PRICE_TO_PLAN: Record<string, { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }> = {
  [process.env.PRICE_BASIC!]: { plan: 'Basic', limit: '10' },
  [process.env.PRICE_PRO!]:   { plan: 'Pro',   limit: '30' },
  [process.env.PRICE_ELITE!]: { plan: 'Elite', limit: 'unlimited' },
}

async function updateSupabaseByEmail(email: string, priceId?: string | null) {
  if (!email || !priceId) return { skipped: 'missing email or priceId', email, priceId }

  const mapping = PRICE_TO_PLAN[priceId]
  if (!mapping) return { skipped: 'unknown price id', email, priceId }

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

  // Upsert by email so it works whether the row exists or not
  const { error } = await supabase
    .from(process.env.SUPABASE_USERS_TABLE || 'users')
    .upsert(
      {
        [process.env.SUPABASE_EMAIL_COLUMN || 'email']: email,
        plan: mapping.plan,
        daily_comp_limit: mapping.limit,
      },
      { onConflict: process.env.SUPABASE_EMAIL_COLUMN || 'email' }
    )

  if (error) throw error
  return { ok: true, email, ...mapping }
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  const body = await req.text()
  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err: any) {
    console.error('Webhook signature verify failed:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    switch (event.type) {
      /**
       * Primary path when using Checkout
       */
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session

        // Email
        let email = s.customer_details?.email || null
        if (!email && s.customer) {
          const cust = await stripe.customers.retrieve(s.customer as string)
          if (!('deleted' in cust)) email = cust.email ?? null
        }

        // Price
        let priceId: string | null = null
        if (s.mode === 'subscription' && s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription as string, { expand: ['items.data.price'] })
          priceId = sub.items.data[0]?.price?.id ?? null
        }

        const res = await updateSupabaseByEmail(email!, priceId)
        console.log('WH update (checkout.session.completed):', { event: event.id, ...res })
        break
      }

      /**
       * Backup paths (your endpoint is receiving these now)
       * We read subscription & customer to get priceId + email, then update.
       */
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'invoice.payment_succeeded': {
        let subscriptionId: string | null = null
        let customerId: string | null = null

        const obj: any = event.data.object
        if (obj.object === 'subscription') {
          const sub = obj as Stripe.Subscription
          subscriptionId = sub.id
          customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
        } else if (obj.object === 'invoice') {
          const inv = obj as Stripe.Invoice
          subscriptionId = typeof inv.subscription === 'string' ? inv.subscription : null
          customerId = typeof inv.customer === 'string' ? inv.customer : null
        }

        // Email
        let email: string | null = null
        if (customerId) {
          const cust = await stripe.customers.retrieve(customerId)
          if (!('deleted' in cust)) email = cust.email ?? null
        }

        // Price
        let priceId: string | null = null
        if (subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] })
          priceId = sub.items.data[0]?.price?.id ?? null
        }

        const res = await updateSupabaseByEmail(email!, priceId)
        console.log('WH update (sub/invoice):', { event: event.id, type: event.type, ...res })
        break
      }

      default:
        // Not needed for tagging
        console.log('WH ignore:', event.type)
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('Webhook processing error:', err?.message || err)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}
