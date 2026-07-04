import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { normalizeEvents } from '@/lib/webhooks/events'
import {
  WEBHOOK_PUBLIC_COLUMNS,
  serializeWebhookEndpoint,
  normalizeWebhookUrl,
} from '@/lib/webhooks/endpoints'

async function getAccountId(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()

  return data?.account_id ?? null
}

type RouteContext = { params: Promise<Record<string, string>> }

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const supabase = await createClient()
    const accountId = await getAccountId(supabase)
    if (!accountId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await context.params
    const body = await request.json().catch(() => null)
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const updates: Record<string, unknown> = {}

    if ('url' in body) {
      const url = normalizeWebhookUrl(body.url)
      if (!url) return NextResponse.json({ error: "'url' must be a valid https:// URL" }, { status: 400 })
      updates.url = url
    }

    if ('events' in body) {
      const events = normalizeEvents(body.events)
      if (!events) return NextResponse.json({ error: "'events' must be a non-empty array" }, { status: 400 })
      updates.events = events
    }

    if ('is_active' in body) {
      if (typeof body.is_active !== 'boolean') return NextResponse.json({ error: "'is_active' must be boolean" }, { status: 400 })
      updates.is_active = body.is_active
      if (body.is_active === true) updates.failure_count = 0
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('webhook_endpoints')
      .update(updates)
      .eq('id', id)
      .eq('account_id', accountId)
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .maybeSingle()

    if (error) return NextResponse.json({ error: 'Failed to update webhook' }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

    return NextResponse.json({ data: serializeWebhookEndpoint(data as Record<string, unknown>) })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const supabase = await createClient()
    const accountId = await getAccountId(supabase)
    if (!accountId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await context.params

    const { data, error } = await supabase
      .from('webhook_endpoints')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id')
      .maybeSingle()

    if (error) return NextResponse.json({ error: 'Failed to delete webhook' }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Webhook not found' }, { status: 404 })

    return NextResponse.json({ data: { id: data.id, deleted: true } })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}