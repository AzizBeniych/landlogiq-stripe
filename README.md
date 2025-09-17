LandLogiq — Stripe ↔️ Next.js (Vercel) ↔️ Supabase

Paid plans from Framer CTAs, stored in Supabase, running on Vercel

TL;DR: Buttons on your site go to /api/checkout/basic|pro|elite → Stripe Checkout → webhook updates Supabase → your app knows the user’s plan/limit.

0) What you get

Clean URLs for CTAs:
/api/checkout/basic, /api/checkout/pro, /api/checkout/elite

Stripe Checkout (subscription) sessions created server-side.

Webhook that upserts the user’s plan into Supabase table public.billing_users.

Admin fallback endpoint to set a plan manually by email (guarded by a secret).

All wired for Vercel App Router (app/api/.../route.ts).

1) Understand the flow in 15 seconds
[Framer CTA] --> https://your-app.com/api/checkout/basic
                       |
                       v
                [Stripe Checkout]
                       |
                 (payment success)
                       |
             [Stripe → Webhook call]
                       |
                       v
      [Next.js webhook] --upsert--> [Supabase.billing_users]


Your button links the user to our API.

We create a subscription checkout session (using the right Price ID).

Stripe sends us a webhook when it’s completed.

We write { email, plan, daily_comp_limit } to Supabase.

2) One-time setup (in this exact order)
A. Create Supabase table

Run this SQL once in the Supabase SQL editor:

create table if not exists public.billing_users
(
  id uuid default gen_random_uuid() primary key,
  email text not null,
  plan text,
  daily_comp_limit text
);

create unique index if not exists billing_users_email_key
  on public.billing_users (email);


👉 This table is where we write the final plan. Keep your legacy public.users separate.

B. Get Stripe Price IDs (Test mode first)

In Stripe Products → Prices (Test mode):

Create 3 recurring prices:

Basic → monthly → note its Price ID (looks like price_123)

Pro → monthly → Price ID

Elite → monthly → Price ID

We will paste these into environment variables.

C. Create a Vercel project from this repo

Import the GitHub repo into Vercel.

Don’t deploy yet—we need to add env vars.

D. Add Environment Variables (Vercel → Settings → Environment Variables)

Add all of these (values shown are examples):

KEY	VALUE (example)
STRIPE_SECRET_KEY	sk_test_51... (Test mode now; later swap to Live)
STRIPE_WEBHOOK_SECRET	whsec_... (fill after webhook setup, see below)
SUPABASE_URL	https://xyzcompany.supabase.co
SUPABASE_SERVICE_ROLE_KEY	your-service-role-key (server-side only!)
PRICE_BASIC	price_abc123 (your Basic Price ID)
PRICE_PRO	price_def456 (your Pro Price ID)
PRICE_ELITE	price_ghi789 (your Elite Price ID)
SUCCESS_URL	https://landlogiq.com/dashboard (or your local URL for testing)
CANCEL_URL	https://landlogiq.com/#pricing
ADMIN_SET_PLAN_SECRET	any-long-random-string

You can set different values for Development / Preview / Production in Vercel. Start with Preview/Production = Test Stripe keys. You’ll switch to Live later.

E. Deploy (first time)

Trigger a deploy in Vercel (now that env vars are set).

We still need to connect the Stripe webhook (next step).

F. Add the Stripe webhook (Test mode)

Stripe Dashboard → Developers → Webhooks → Add endpoint:

Endpoint URL: https://<your-vercel-domain>/api/stripe-webhook

Events to send: Start with checkout.session.completed

Save → Stripe shows a Signing secret (looks like whsec_...)

Copy that secret to your Vercel env var: STRIPE_WEBHOOK_SECRET (for the same environment you’ll test in). Redeploy.

This lets the webhook verify Stripe’s signatures and reject fakes.

3) Try it in 60 seconds (Test mode)

Open https://<your-app>/api/checkout/basic

On the Stripe page use 4242 4242 4242 4242, any future expiry, any CVC/name.

On success you’ll be redirected to SUCCESS_URL.

In Vercel logs you should see webhook POST → 200.

In Supabase → public.billing_users you should now see:

email = <the email you entered in checkout>
plan = Basic
daily_comp_limit = 10


Repeat for /api/checkout/pro → expect 30, and /api/checkout/elite → expect unlimited.

4) Hook up your site buttons (Framer, etc.)

Use these exact URLs for your CTAs:

Basic: https://<your-app>/api/checkout/basic

Pro: https://<your-app>/api/checkout/pro

Elite: https://<your-app>/api/checkout/elite

Framer:

Select the button → “Link” → “URL” → paste the URL above.

That’s it. Your button will open Stripe Checkout through our API.

5) What files do what?
app/
  api/
    checkout/
      [plan]/
        route.ts    # Preferred CTA: /api/checkout/basic|pro|elite
                     # Reads the plan, looks up the right Price ID, creates a Stripe session
                     # and 303-redirects to Stripe Checkout.

    create-checkout-session/
      route.ts      # Legacy endpoint: /api/create-checkout-session?plan=basic|pro|elite
                     # Kept for backwards compatibility. Use /api/checkout/[plan] instead.

    stripe-webhook/
      route.ts      # Verifies Stripe signature; on checkout.session.completed,
                     # fetches price/product, resolves plan mapping, upserts Supabase:
                     #  - email (unique)
                     #  - plan (Basic|Pro|Elite)
                     #  - daily_comp_limit (10|30|unlimited)

    admin-set-plan/
      route.ts      # Manual admin upsert. Call with:
                     #  POST /api/admin-set-plan?secret=<ADMIN_SET_PLAN_SECRET>
                     #  body { "email": "", "plan": "Basic|Pro|Elite" }

6) Local development (optional)

If you want to run this locally:

Install deps

pnpm i   # or npm i / yarn


Create .env.local with Test values:

STRIPE_SECRET_KEY=sk_test_...
SUPABASE_URL=https://xyzcompany.supabase.co
SUPABASE_SERVICE_ROLE_KEY=service_role_...
PRICE_BASIC=price_abc123
PRICE_PRO=price_def456
PRICE_ELITE=price_ghi789
SUCCESS_URL=http://localhost:3000/success
CANCEL_URL=http://localhost:3000/cancel
ADMIN_SET_PLAN_SECRET=super-long-string


Start dev:

pnpm dev   # or npm run dev / yarn dev


(Optional) Stripe CLI to forward webhooks:

stripe login
stripe listen --forward-to localhost:3000/api/stripe-webhook


Copy the printed whsec_... and set STRIPE_WEBHOOK_SECRET in .env.local.

Open http://localhost:3000/api/checkout/basic and test.

7) How the plan/limits are chosen (mapping)

We look up the Price/Product ID on the subscription item and map it to:

Plan	Env var	Limit
Basic	PRICE_BASIC	10
Pro	PRICE_PRO	30
Elite	PRICE_ELITE	unlimited

If any of the env vars are missing/wrong, mapping can’t happen. Fix the env var → redeploy.

8) Admin fallback (for manual fixes)

If you need to set/override someone’s plan by email:

curl -X POST "https://<your-app>/api/admin-set-plan?secret=<ADMIN_SET_PLAN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","plan":"Pro"}'


Response:

{ "ok": true, "email": "user@example.com", "plan": "Pro", "daily_comp_limit": "30" }


Use this only when absolutely necessary.

9) Go Live (switch to real money)

Do these in order:

In Stripe Live mode: create 3 recurring prices and copy their Live Price IDs.

In Vercel Production env:

Change STRIPE_SECRET_KEY → Live secret key (sk_live_...)

Update PRICE_BASIC / PRICE_PRO / PRICE_ELITE → Live price IDs

Ensure SUCCESS_URL / CANCEL_URL are your real URLs

In Stripe Live mode:

Create a new webhook endpoint for https://<your-app>/api/stripe-webhook

Subscribe to checkout.session.completed

Paste the Live STRIPE_WEBHOOK_SECRET into Vercel

Redeploy

Perform one $1–$5 real purchase on Basic to confirm:

Webhook shows 200 in Vercel logs

Supabase billing_users updated with plan=Basic and daily_comp_limit=10

10) Common “it doesn’t work” fixes

Internal error on /api/checkout/basic

STRIPE_SECRET_KEY missing/invalid

PRICE_BASIC missing/invalid (must be a Price ID, not a Product ID)

Webhook retries / 400 signature error

Wrong STRIPE_WEBHOOK_SECRET. Use the exact value from Stripe for this endpoint+mode.

Supabase not updating

Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel

Ensure table is public.billing_users

Make sure the Checkout collected an email (Stripe’s checkout page asks for it)

Plan shows wrong

You pasted the wrong Price ID in an env var (e.g., Pro price in PRICE_BASIC). Fix & redeploy.

11) Security

SUPABASE_SERVICE_ROLE_KEY is server-only. Never expose it to the browser.

Webhook verifies every event with STRIPE_WEBHOOK_SECRET.

Admin endpoint is protected by ADMIN_SET_PLAN_SECRET. Keep it secret or omit the route if you don’t want this fallback.

12) FAQ

Q: Can I keep using /api/create-checkout-session?plan=pro?
A: Yes (legacy). Prefer /api/checkout/pro for cleaner URLs in CTAs.

Q: Do I need Stripe Customer Portal?
A: Not for this flow. You can add it later to manage cancellations/upgrades.

Q: Can I add annual plans?
A: Yes—create annual prices in Stripe, add new env vars, extend the mapping logic, and add routes like /api/checkout/basic-annual.

13) Quick sanity test checklist (copy/paste)

Add all env vars in Vercel (Test mode)

Deploy

Stripe Webhook (Test) → set endpoint + paste whsec to Vercel

Visit /api/checkout/basic → pay with 4242 4242 4242 4242

See 200 in Vercel logs for the webhook

Supabase billing_users shows row with plan=Basic and daily_comp_limit=10

Link CTAs in Framer to /api/checkout/basic (and Pro/Elite)

Switch to Live keys + Live prices + Live webhook when ready

14) Tech

Next.js App Router

Stripe Node SDK

Supabase JS (service role)

TypeScript

Node 18+
