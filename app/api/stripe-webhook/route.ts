// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Accept either price_ IDs or prod_ IDs in env
const ENV_IDS = {
  Basic: process.env.PRICE_BASIC!,
  Pro: process.env.PRICE_PRO!,
  Elite: process.env.PRICE_ELITE!,
}

type PlanInfo = { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }

function resolvePlanById(id?: string): PlanInfo | undefined {
  if (!id) return
  for (const [label, envId] of Object.entries(ENV_IDS) as Array<[keyof typeof ENV_IDS, string]>) {
    if (!envId) continue
    if (envId === id) {
      if (label === 'Basic') return { plan: 'Basic', limit: '10' }
      if (label === 'Pro')   return { plan: 'Pro',   limit: '30' }
      if (label === 'Elite') return { plan: 'Elite', limit: 'unlimited' }
    }
  }
  return
}

function resolvePlanFromSubscription(sub: Stripe.Subscription): PlanInfo | undefined {
  const item = sub.items.data[0]
  const price = item?.price
  const priceId = price?.id
  const productId = typeof price?.product === 'string' ? price.product : price?.product?.id
  return resolvePlanById(priceId) || resolvePlanById(productId)
}

async function getEmailFromCustomer(customerId?: string | null) {
  if (!customerId) return undefined
  try {
    const cust = await stripe.customers.retrieve(customerId as string)
    if (!('deleted' in cust)) return cust.email || undefined
  } catch {}
  return undefined
}

async function upsertPlan(email: string, mapping?: PlanInfo) {
  if (!mapping) return { skipped: 'no plan mapping' }
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
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
  return { ok: true }
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  const body = await req.text()
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err: any) {
    console.error('[WH] signature error:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    switch (event.type) {
      // You’re already receiving these events—no Dashboard changes needed.
      case 'invoice.payment_succeeded': {
        const inv = event.data.object as Stripe.Invoice
        let email = inv.customer_email || (await getEmailFromCustomer(inv.customer as string | undefined))

        let mapping: PlanInfo | undefined
        if (inv.subscription) {
          const sub = await stripe.subscriptions.retrieve(inv.subscription as string)
          mapping = resolvePlanFromSubscription(sub)
        }
        if (email) await upsertPlan(email, mapping)
        else console.warn('[WH] invoice.payment_succeeded: missing email')
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subObj = event.data.object as Stripe.Subscription
        // Ensure we have a fully populated sub (sometimes not expanded)
        const sub = await stripe.subscriptions.retrieve(subObj.id)
        const mapping = resolvePlanFromSubscription(sub)
        const email = await getEmailFromCustomer(sub.customer as string)
        if (email) await upsertPlan(email, mapping)
        else console.warn('[WH] subscription.*: missing email')
        break
      }

      // If you ever add this in Stripe later, it’ll work too—but not required now.
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        let email =
          session.customer_details?.email ||
          (await getEmailFromCustomer(session.customer as string | undefined))

        let mapping: PlanInfo | undefined
        if (session.mode === 'subscription' && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string)
          mapping = resolvePlanFromSubscription(sub)
        }
        if (email) await upsertPlan(email, mapping)
        else console.warn('[WH] checkout.completed: missing email')
        break;
      }

      default:
        // 200 OK so Stripe stops retrying for unhandled events
        // console.log('[WH] ignoring', event.type)
        break
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('[WH] handler error:', err?.message || err)
    return NextResponse.json({ error: 'Internal webhook error' }, { status: 500 })
  }
}
