import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  toErrorResponse,
} from '@/lib/auth/account';
import { toCallRecording } from '@/lib/recordings/recordings';

/** Default page size — matches the contacts list convention. */
const DEFAULT_LIMIT = 25;
/** Hard ceiling so one request can't dump the whole catalog. */
const MAX_LIMIT = 100;

/**
 * GET /api/recordings?limit=&offset= — account-scoped recording
 * list for the Recordings page. Any member may read (mirrors the
 * `call_recordings_select` RLS policy). Newest call first.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const params = new URL(request.url).searchParams;
    const limit = Math.min(
      Math.max(Number(params.get('limit')) || DEFAULT_LIMIT, 1),
      MAX_LIMIT
    );
    const offset = Math.max(Number(params.get('offset')) || 0, 0);

    const { data, error, count } = await supabase
      .from('call_recordings')
      .select('*', { count: 'exact' })
      .eq('account_id', accountId)
      .order('recorded_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    return NextResponse.json({
      recordings: ((data ?? []) as Record<string, unknown>[]).map(toCallRecording),
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
