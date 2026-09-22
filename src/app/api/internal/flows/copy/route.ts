import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  copyFlowAcrossAccounts,
  CopyFlowError,
  type CopyDbClient,
} from '@/lib/flows/cross-account-copy'

/**
 * POST /api/internal/flows/copy — INTERNAL cross-account Flow copy.
 *
 * Undocumented on purpose: there is no button, menu item, setting,
 * tooltip, or help text anywhere in the product that references this
 * capability. It exists for explicit operator-driven work only.
 *
 * Body: { sourceFlowId: UUID, targetAccountId: UUID }
 *
 * Authorization (enforced server-side — "hidden" is not security):
 *   1. caller authenticated (401 otherwise);
 *   2. caller's own RLS-readable profile resolves (403 otherwise);
 *   3. the service requires callerAccountId == source flow's
 *      account_id AND role == 'owner' (outbound owner-consent), so a
 *      caller who merely knows another tenant's flow id gets 403;
 *   4. the target account must exist (404 otherwise).
 *
 * Success: 201 { targetFlowId, targetAccountId, flowName,
 * nodeCount, warnings } — warnings flag dependencies the operator
 * must finish by hand (unmapped tags, cleared assignees/secrets,
 * un-reowned media, unlinked sheets).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as {
    sourceFlowId?: unknown
    targetAccountId?: unknown
  } | null
  const sourceFlowId = typeof body?.sourceFlowId === 'string' ? body.sourceFlowId : ''
  const targetAccountId =
    typeof body?.targetAccountId === 'string' ? body.targetAccountId : ''
  if (!UUID_RE.test(sourceFlowId) || !UUID_RE.test(targetAccountId)) {
    return NextResponse.json(
      { error: 'sourceFlowId and targetAccountId must be UUIDs.' },
      { status: 400 },
    )
  }

  // Caller identity comes from their own RLS-scoped profile row —
  // never from client-supplied account fields (there are none).
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', user.id)
    .maybeSingle()
  const callerAccountId =
    profile && typeof profile.account_id === 'string' ? profile.account_id : null
  const callerRole =
    profile && typeof profile.account_role === 'string' ? profile.account_role : null
  if (!callerAccountId || !callerRole) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const result = await copyFlowAcrossAccounts(
      supabaseAdmin() as unknown as CopyDbClient,
      {
        callerUserId: user.id,
        callerAccountId,
        callerRole,
        sourceFlowId,
        targetAccountId,
      },
    )
    return NextResponse.json(
      {
        targetFlowId: result.targetFlowId,
        targetAccountId: result.targetAccountId,
        flowName: result.flowName,
        nodeCount: result.nodeCount,
        warnings: result.warnings,
      },
      { status: 201 },
    )
  } catch (err) {
    if (err instanceof CopyFlowError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('[internal/flows/copy] unexpected error:', err)
    return NextResponse.json({ error: 'Copy failed.' }, { status: 500 })
  }
}
