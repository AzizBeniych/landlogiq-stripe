import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

const PLAN_TO_PRICE: Record<string, string> = {
  basic: process.env.PRICE_BASIC!,
  pro: process.env.PRICE_PRO!,
  elite: process.env.PRICE_ELITE!,
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const plan = (searchParams.get('plan') || '').toLowerCase()

    if (!['basic', 'pro', 'elite'].includes(plan)) {
      return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
    }

    const price = PLAN_TO_PRICE[plan]

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
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
  }
}
