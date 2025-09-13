// app/api/create-checkout-session/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// We will allow envs that are price_... OR prod_...
const PLAN_TO_ID: Record<string, string> = {
  basic: process.env.PRICE_BASIC!,
  pro: process.env.PRICE_PRO!,
  elite: process.env.PRICE_ELITE!,
}

async function resolveLineItem(id: string): Promise<Stripe.Checkout.SessionCreateParams.LineItem> {
  if (id.startsWith('price_')) {
    return { price: id, quantity: 1 }
  }
  if (id.startsWith('prod_')) {
    // find an active MONTHLY recurring price attached to this product
    const prices = await stripe.prices.list({ product: id, active: true, limit: 20 })
    const monthly = prices.data.find(p => p.recurring?.interval === 'month')
    if (!monthly) throw new Error(`No active monthly price for product ${id}`)
    return { price: monthly.id, quantity: 1 }
  }
  throw new Error('Invalid ID in env (must start with price_ or prod_)')
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const plan = (searchParams.get('plan') || '').toLowerCase()
    if (!['basic', 'pro', 'elite'].includes(plan)) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
    }

    const id = PLAN_TO_ID[plan]
    const lineItem = await resolveLineItem(id)

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [lineItem],
      success_url: process.env.SUCCESS_URL,
      cancel_url: process.env.CANCEL_URL,
      customer_creation: 'always',
      customer_update: { name: 'auto', address: 'auto' },
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
    })

    return NextResponse.redirect(session.url!, { status: 303 })
  } catch (err: any) {
    console.error('create-checkout-session error', err)
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 })
