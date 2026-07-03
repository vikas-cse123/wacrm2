import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/whatsapp/encryption'
import { normalizeEvents } from '@/lib/webhooks/events'
import {
  WEBHOOK_PUBLIC_COLUMNS,
  serializeWebhookEndpoint,
  generateWebhookSecret,
  normalizeWebhookUrl,
} from '@/lib/webhooks/endpoints'

async function getAccountId(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase
    .from('account_members')
    .select('account_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  return data?.account_id ?? null
}

export async function GET() {
  try {
    const supabase = await createClient()
    const accountId = await getAccountId(supabase)
    if (!accountId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data, error } = await supabase
      .from('webhook_endpoints')
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })

    if (error) return NextResponse.json({ error: 'Failed to list webhooks' }, { status: 500 })

    return NextResponse.json({
      data: (data ?? []).map((r) => serializeWebhookEndpoint(r as Record<string, unknown>))
    })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const accountId = await getAccountId(supabase)
    if (!accountId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const url = normalizeWebhookUrl(body.url)
    if (!url) return NextResponse.json({ error: "'url' must be a valid https:// URL" }, { status: 400 })

    const events = normalizeEvents(body.events)
    if (!events) return NextResponse.json({ error: "'events' must be a non-empty array of known event names" }, { status: 400 })

    const secret = generateWebhookSecret()

    const { data: created, error } = await supabase
      .from('webhook_endpoints')
      .insert({
        account_id: accountId,
        created_by: user.id,
        url,
        secret: encrypt(secret),
        events,
      })
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .single()

    if (error || !created) {
      console.error('[internal/webhooks] create error:', error)
      return NextResponse.json({ error: 'Failed to create webhook' }, { status: 500 })
    }

    return NextResponse.json({
      data: { ...serializeWebhookEndpoint(created as Record<string, unknown>), secret }
    }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}