// app/api/admin-set-plan/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const PLAN_LIMIT: Record<'basic'|'pro'|'elite', {plan:'Basic'|'Pro'|'Elite'; limit:string}> = {
  basic: { plan: 'Basic', limit: '10' },
  pro:   { plan: 'Pro',   limit: '30' },
  elite: { plan: 'Elite', limit: 'unlimited' },
}

export async function GET(req: NextRequest) {
  // 1) auth
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret') || req.headers.get('x-admin-secret')
  if (!secret || secret !== process.env.ADMIN_PLAN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2) inputs
  const email = (url.searchParams.get('email') || '').trim().toLowerCase()
  const planKey = (url.searchParams.get('plan') || '').trim().toLowerCase() as 'basic'|'pro'|'elite'

  if (!email || !['basic','pro','elite'].includes(planKey)) {
    return NextResponse.json({ error: 'Usage: /api/admin-set-plan?email=USER@MAIL.com&plan=basic|pro|elite' }, { status: 400 })
  }

  const mapping = PLAN_LIMIT[planKey]

  // 3) supabase write (upsert by email)
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const emailCol = process.env.SUPABASE_EMAIL_COLUMN || 'email'
  const table = process.env.SUPABASE_USERS_TABLE || 'users'

  const { error } = await supabase
    .from(table)
    .upsert(
      { [emailCol]: email, plan: mapping.plan, daily_comp_limit: mapping.limit },
      { onConflict: emailCol }
    )

  if (error) return NextResponse.json({ ok: false, error }, { status: 500 })

  return NextResponse.json({ ok: true, email, plan: mapping.plan, daily_comp_limit: mapping.limit })
}
