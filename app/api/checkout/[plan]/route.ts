// app/api/checkout/[plan]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

export const runtime = 'nodejs' // use Node runtime for Stripe SDK

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

// Map friendly alias -> your existing Price IDs from env
const PLAN_TO_PRICE: Record<string, string> = {
  basic: process.env.PRICE_BASIC!,
  pro: process.env.PRICE_PRO!,
  elite: process.env.PRICE_ELITE!,
}

export async function GET(_req: NextRequest, ctx: { params: { plan: string } }) {
  try {
    const plan = (ctx.params?.plan || '').toLowerCase()
    const price = PLAN_TO_PRICE[plan]
    if (!price) {
      // Unknown plan -> send back to pricing
      const cancel = process.env.CANCEL_URL || 'https://landlogiq.com/pricing'
      return NextResponse.redirect(cancel, 302)
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      success_url: process.env.SUCCESS_URL || 'https://landlogiq.com/dashboard',
      cancel_url: process.env.CANCEL_URL || 'https://landlogiq.com/pricing',
      customer_creation: 'always',                    // ensures a Customer exists
      customer_update: { name: 'auto', address: 'auto' },
      allow_promotion_codes: true,                    // optional, handy in live
    })

    return NextResponse.redirect(session.url!, { status: 303 })
  } catch (err: any) {
    console.error('[checkout-alias] error:', err?.message || err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
