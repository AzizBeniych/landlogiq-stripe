// app/api/checkout/[plan]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

export const runtime = 'nodejs'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' })

const PLAN_TO_PRICE: Record<string, string | undefined> = {
  basic: process.env.PRICE_BASIC,
  pro: process.env.PRICE_PRO,
  elite: process.env.PRICE_ELITE,
}

export async function GET(_req: NextRequest, ctx: { params: { plan: string } }) {
  try {
    // Validate Stripe key once
    if (!process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json({ error: 'Missing STRIPE_SECRET_KEY' }, { status: 500 })
    }

    const plan = (ctx.params?.plan || '').toLowerCase()
    const price = PLAN_TO_PRICE[plan]
    if (!price) {
      const cancel = process.env.CANCEL_URL || 'https://landlogiq.com/pricing'
      return NextResponse.redirect(cancel, 302)
    }

    const successUrl = process.env.SUCCESS_URL || 'https://landlogiq.com/dashboard'
    const cancelUrl = process.env.CANCEL_URL || 'https://landlogiq.com/pricing'

    // IMPORTANT: Do NOT set customer_creation in subscription mode
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true, // optional
      // No customer_creation here (payment-mode only)
    })

    return NextResponse.redirect(session.url!, { status: 303 })
  } catch (err: any) {
    console.error('[checkout-alias] error:', err?.message || err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
