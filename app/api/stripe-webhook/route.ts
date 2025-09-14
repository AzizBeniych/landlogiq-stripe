// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs' // ensure NOT edge so we can read raw body

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Accept either price_… or prod_… in env
const ENV_IDS = {
  Basic: process.env.PRICE_BASIC!,
  Pro: process.env.PRICE_PRO!,
  Elite: process.env.PRICE_ELITE!,
}
type PlanInfo = { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }

// Map by price OR product id
function resolvePlan(priceId?: string, productId?: string): PlanInfo | undefined {
  for (const [label, id] of Object.entries(ENV_IDS)) {
    if (!id) continue
    if (id.startsWith('price_') && priceId && id === priceId) {
      if (label === 'Basic') return { plan: 'Basic', limit: '10' }
      if (label === 'Pro')   return { plan: 'Pro',   limit: '30' }
      if (label === 'Elite') return { plan: 'Elite', limit: 'unlimited' }
    }
    if (id.startsWith('prod_') && productId && id === productId) {
      if (label === 'Basic') return { plan: 'Basic', limit: '10' }
      if (label === 'Pro')   return { plan: 'Pro',   limit: '30' }
      if (label === 'Elite') return { plan: 'Elite', limit: 'unlimited' }
    }
  }
  return undefined
}

async function getEmailFromCustomer(customer: string | Stripe.Customer | null): Promise<string | undefined> {
  if (!customer) return undefined
  if (typeof customer !== 'string') return customer.email ?? undefined
  const c = await stripe.customers.retrieve(customer)
  return 'deleted' in c ? undefined : c.email ?? undefined
}

async function getPriceAndProductFromSub(subscriptionId: string) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price.product'],
  })
  const item = sub.items.data[0]
  const priceId = item?.price?.id
  const prod = item?.price?.product as string | Stripe.Product | undefined
  const productId = typeof prod === 'string' ? prod : prod?.id
  return { priceId, productId }
}

async function upsertSupabase(email: string, mapping: PlanInfo) {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const table = process.env.SUPABASE_USERS_TABLE || 'users'
  const emailCol = process.env.SUPABASE_EMAIL_COLUMN || 'email'

  // upsert → create if not exists
  const { error } = await supabase
    .from(table)
    .upsert(
      { [emailCol]: email, plan: mapping.plan, daily_comp_limit: mapping.limit },
      { onConflict: emailCol }
    )

  if (error) throw new Error(`Supabase upsert failed: ${error.message}`)
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  const rawBody = await req.text()
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err: any) {
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    switch (event.type) {
      /**
       * Primary path: user finished checkout
       */
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session

        // Email (several fallbacks)
        let email =
          session.customer_details?.email ||
          (session as any).customer_email ||
          (await getEmailFromCustomer(session.customer as any))

        // Price/product (get from subscription)
        let priceId: string | undefined
        let productId: string | undefined
        if (session.mode === 'subscription' && session.subscription) {
          const ids = await getPriceAndProductFromSub(session.subscription as string)
          priceId = ids.priceId
          productId = ids.productId
        }

        const mapping = resolvePlan(priceId, productId)
        if (!email || !mapping) {
          console.warn('WH: missing email or mapping', { email, priceId, productId })
          return NextResponse.json({ received: true }, { status: 200 })
        }

        await upsertSupabase(email, mapping)
        break
      }

      /**
       * Backup path #1: subscription created without checkout session
       */
      case 'customer.subscription.created': {
        const sub = event.data.object as Stripe.Subscription
        const email = await getEmailFromCustomer(sub.customer as any)

        const item = sub.items.data[0]
        const priceId = item?.price?.id
        const prod = item?.price?.product as string | Stripe.Product | undefined
        const productId = typeof prod === 'string' ? prod : prod?.id

        const mapping = resolvePlan(priceId, productId)
        if (!email || !mapping) {
          console.warn('WH(sub.created) missing email or mapping', { email, priceId, productId })
          return NextResponse.json({ received: true }, { status: 200 })
        }

        await upsertSupabase(email, mapping)
        break
      }

      /**
       * Backup path #2: first invoice succeeds → fetch sub and tag
       */
      case 'invoice.payment_succeeded': {
        const inv = event.data.object as Stripe.Invoice
        const email = inv.customer_email || (await getEmailFromCustomer(inv.customer as any))
        const subId = typeof inv.subscription === 'string' ? inv.subscription : undefined
        if (!subId) return NextResponse.json({ received: true }, { status: 200 })

        const { priceId, productId } = await getPriceAndProductFromSub(subId)
        const mapping = resolvePlan(priceId, productId)
        if (!email || !mapping) {
          console.warn('WH(invoice) missing email or mapping', { email, priceId, productId })
          return NextResponse.json({ received: true }, { status: 200 })
        }

        await upsertSupabase(email, mapping)
        break
      }

      default:
        // ignore everything else
        break
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('Webhook handler error', err)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}

// Keep raw body for signature verification (Vercel/Next)
export const config = {
  api: { bodyParser: false },
}
