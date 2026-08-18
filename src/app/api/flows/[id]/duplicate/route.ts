import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { uniqueCopyName } from '@/lib/flows/duplicate'

/**
 * POST /api/flows/[id]/duplicate — copy an existing flow.
 *
 * Creates a fully independent draft copy of the caller's flow:
 *   - new flow UUID + new flow_nodes UUIDs (node_key stays a stable
 *     string, so edge references in each node's config resolve within
 *     the copy's own (flow_id, node_key) scope — no UUID rewriting
 *     needed, mirroring the template clone path in /api/flows).
 *   - status forced to 'draft' so duplicating never auto-activates.
 *   - execution_count / last_executed_at reset (fresh history).
 *
 * Ownership is checked through the caller's RLS-scoped client, so a
 * flow from another account/workspace returns 404, exactly like the
 * GET/PUT/DELETE handlers in flows/[id]/route.ts.
 */

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // RLS scopes this to the caller's account — a flow owned by another
  // tenant/workspace returns null (404 below).
  const { data: owned } = await supabase
    .from('flows')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (!owned) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const admin = supabaseAdmin()

  const { data: original } = await admin
    .from('flows')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (!original) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Fetch the source nodes + every flow name in this account in parallel.
  // Names are read via the admin client but scoped to the ORIGINAL flow's
  // account, so the copy name can never collide with another workspace.
  const [{ data: nodes }, { data: nameRows }] = await Promise.all([
    admin
      .from('flow_nodes')
      .select('*')
      .eq('flow_id', id)
      .order('created_at', { ascending: true }),
    admin.from('flows').select('name').eq('account_id', original.account_id),
  ])

  const existingNames = (nameRows ?? []).map((r: { name: string }) => r.name)
  const copyName = uniqueCopyName(original.name, existingNames)

  const { data: copy, error: copyErr } = await admin
    .from('flows')
    .insert({
      account_id: original.account_id,
      user_id: user.id,
      name: copyName,
      description: original.description,
      status: 'draft',
      trigger_type: original.trigger_type,
      trigger_config: original.trigger_config,
      entry_node_id: original.entry_node_id,
      fallback_policy: original.fallback_policy,
      execution_count: 0,
      last_executed_at: null,
    })
    .select()
    .single()
  if (copyErr || !copy) {
    return NextResponse.json(
      { error: copyErr?.message ?? 'copy failed' },
      { status: 500 },
    )
  }

  if (nodes && nodes.length > 0) {
    const { error: insErr } = await admin.from('flow_nodes').insert(
      nodes.map((n) => ({
        flow_id: copy.id,
        node_key: n.node_key,
        node_type: n.node_type,
        config: n.config,
        position_x: n.position_x,
        position_y: n.position_y,
      })),
    )
    if (insErr) {
      // Roll back the parent flow so a half-copied flow doesn't sit as
      // an empty draft. CASCADE on flow_id removes the partial nodes.
      await admin.from('flows').delete().eq('id', copy.id)
      return NextResponse.json({ error: insErr.message }, { status: 500 })
    }
  }

  return NextResponse.json({ flow: copy }, { status: 201 })
}
