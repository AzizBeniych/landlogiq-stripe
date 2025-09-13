// app/api/stripe-webhook/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Allow envs to be either price_… OR prod_…
const ENV_IDS = {
  Basic: process.env.PRICE_BASIC || '',
  Pro: process.env.PRICE_PRO || '',
  Elite: process.env.PRICE_ELITE || '',
}

type PlanInfo = { plan: 'Basic' | 'Pro' | 'Elite'; limit: string }

function mappingFor(label: keyof typeof ENV_IDS): PlanInfo {
  if (label === 'Basic') return { plan: 'Basic', limit: '10' }
  if (label === 'Pro')   return { plan: 'Pro',   limit: '30' }
  return { plan: 'Elite', limit: 'unlimited' }
}

function resolvePlan(priceId?: string, productId?: string): PlanInfo | undefined {
  for (const [label, id] of Object.entries(ENV_IDS) as Array<[keyof typeof ENV_IDS, string]>) {
    if (!id) continue
    // exact match on price id
    if (priceId && id.startsWith('price_') && id === priceId) return mappingFor(label)
    // exact match on product id
    if (productId && id.startsWith('prod_') && id === productId) return mappingFor(label)
  }
  return undefined
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('stripe-signature')
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })

  const rawBody = await req.text()

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err?.message)
    return NextResponse.json({ error: `Webhook Error: ${err.message}` }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session

      // Email
      let email = session.customer_details?.email || (session as any).customer_email || undefined
      if (!email && session.customer) {
        const cust = await stripe.customers.retrieve(session.customer as string)
        if (!('deleted' in cust)) email = cust.email || undefined
      }

      // Price + Product from the subscription
      let priceId: string | undefined
      let productId: string | undefined
      if (session.mode === 'subscription' && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription as string, {
          expand: ['items.data.price.product'],
        })
        const item = sub.items.data[0]
        priceId = item?.price?.id
        const prod = item?.price?.product as string | Stripe.Product | undefined
        productId = typeof prod === 'string' ? prod : prod?.id
      }

      const mapping = resolvePlan(priceId, productId)

      // 🔎 Debug line you’ll see in Vercel → Logs
      console.log('WH DEBUG:', { email, priceId, productId, mapping, ENV_IDS })

      if (!email || !mapping) {
        // return 200 so Stripe doesn’t retry; we just don’t update
        console.warn('WH WARN: Missing email or mapping. Skipping update.', { email, priceId, productId })
        return NextResponse.json({ received: true, note: 'missing email or mapping' }, { status: 200 })
      }

      const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

      const { error } = await supabase
        .from(process.env.SUPABASE_USERS_TABLE || 'users')
        .update({
          plan: mapping.plan,
          daily_comp_limit: mapping.limit,
        })
        .eq(process.env.SUPABASE_EMAIL_COLUMN || 'email', email)

      if (error) {
        console.error('WH ERROR: Supabase update failed', error)
        return NextResponse.json({ error: 'Supabase update failed' }, { status: 500 })
      }
    }

    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err: any) {
    console.error('WH ERROR:', err)
    return NextResponse.json({ error: 'Internal webhook handler error' }, { status: 500 })
  }
}
