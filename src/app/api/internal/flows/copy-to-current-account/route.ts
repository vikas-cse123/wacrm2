import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  copyFlowAcrossAccounts,
  CopyFlowError,
  type CopyDbClient,
} from '@/lib/flows/cross-account-copy'

/**
 * POST /api/internal/flows/copy-to-current-account — self-service
 * Flow-ID copy into the caller's own account.
 *
 * Body: { sourceFlowId: UUID } — and nothing else. In particular
 * there is NO targetAccountId: the destination is always derived
 * server-side from the authenticated caller's own profile, so the
 * browser cannot redirect the copy anywhere.
 *
 * Authorization (target-owner inbound):
 *   1. caller authenticated (401 otherwise);
 *   2. caller's profile resolves AND role is `owner` (403 otherwise
 *      — checked BEFORE any source lookup, so non-owners learn
 *      nothing about arbitrary flow IDs);
 *   3. the service copies source → caller's own account with the
 *      standard remap/draft behavior (unknown IDs read as 404).
 *
 * The pre-existing /api/internal/flows/copy (source-owner
 * outbound) is untouched.
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
  } | null
  const sourceFlowId =
    typeof body?.sourceFlowId === 'string' ? body.sourceFlowId.trim() : ''
  if (!UUID_RE.test(sourceFlowId)) {
    return NextResponse.json(
      { error: 'sourceFlowId must be a UUID.' },
      { status: 400 },
    )
  }

  // Destination = caller's own account, resolved from their own
  // RLS-readable profile. Owner-only: anyone else fails before the
  // source flow is ever looked up.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', user.id)
    .maybeSingle()
  const callerAccountId =
    profile && typeof profile.account_id === 'string' ? profile.account_id : null
  const callerRole =
    profile && typeof profile.account_role === 'string' ? profile.account_role : null
  if (!callerAccountId || callerRole !== 'owner') {
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
        targetAccountId: callerAccountId,
        authorization: 'target-owner',
      },
    )
    return NextResponse.json(
      {
        targetFlowId: result.targetFlowId,
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
    console.error('[internal/flows/copy-to-current-account] unexpected error:', err)
    return NextResponse.json({ error: 'Copy failed.' }, { status: 500 })
  }
}
