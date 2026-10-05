import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  toErrorResponse,
} from '@/lib/auth/account';
import { resolveUploaderName, toCallRecording } from '@/lib/recordings/recordings';
import { uploaderNamesByUserId } from '@/lib/recordings/uploaders';

/** Default page size — matches the contacts list convention. */
const DEFAULT_LIMIT = 25;
/** Hard ceiling so one request can't dump the whole catalog. */
const MAX_LIMIT = 100;

/**
 * GET /api/recordings?limit=&offset=&contact_id= — account-scoped
 * recording list for the Recordings page. Any member may read
 * (mirrors the `call_recordings_select` RLS policy). Newest call
 * first. `contact_id` scopes to one lead's recordings (the lead
 * view); the contact must belong to the caller's account.
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
    const contactId = params.get('contact_id')?.trim() || null;

    // A contact from another workspace must 404 exactly like a
    // nonexistent one (no cross-tenant oracle) — and a missing
    // contact must not silently list the whole account.
    if (contactId) {
      const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contactId)
        .eq('account_id', accountId)
        .maybeSingle();
      if (contactError) throw contactError;
      if (!contact) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        );
      }
    }

    let query = supabase
      .from('call_recordings')
      .select('*', { count: 'exact' })
      .eq('account_id', accountId);
    if (contactId) query = query.eq('contact_id', contactId);
    const { data, error, count } = await query
      .order('recorded_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    const rows = (data ?? []) as Record<string, unknown>[];
    const names = await uploaderNamesByUserId(
      supabase,
      rows.map((r) => r.uploaded_by as string | null).filter(Boolean) as string[]
    );

    return NextResponse.json({
      recordings: rows.map((r) =>
        toCallRecording(
          r,
          r.uploaded_by
            ? (names[r.uploaded_by as string] ?? resolveUploaderName(null))
            : null
        )
      ),
      total: count ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
