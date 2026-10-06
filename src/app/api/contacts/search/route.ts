// ============================================================
// GET /api/contacts/search?q= — lead picker search for the
// "Find Lead" drawer (linking unlinked call recordings).
//
// Account-scoped (session account, never client input), capped at
// 20 rows, metadata only. Matching discipline mirrors upload-time
// matching — suggest confidently, never guess:
//
// - name substring (ilike) — the "search by name" path.
// - EXACT normalized phone equality — the "search by phone" path.
//   Digits are extracted with the existing normalizePhone(); the
//   comparison is equality against contacts.phone_normalized,
//   never partial/suffix/fuzzy.
// - exactMatchId: the single row whose phone_normalized equals the
//   query digits (or null). The UI badges it "Exact phone match"
//   but still requires an explicit click — never auto-links.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

/** Cap: a picker list, not a dump. */
const MAX_RESULTS = 20;
/** Minimum query length — avoids full-table scans on one char. */
const MIN_QUERY = 2;

/** Escape PostgREST ilike wildcards so the query is literal. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface LeadSearchHit {
  id: string;
  name: string | null;
  phone: string | null;
  phone_normalized: string | null;
}

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';
    if (q.length < MIN_QUERY) {
      return NextResponse.json({ leads: [], exactMatchId: null });
    }
    const digits = normalizePhone(q);

    // Name substring always; exact normalized-phone equality when
    // the query carries digits. Both account-scoped, both capped.
    const filters = [`name.ilike.%${escapeLike(q)}%`];
    if (digits) filters.push(`phone_normalized.eq.${digits}`);
    const { data, error } = await supabase
      .from('contacts')
      .select('id, name, phone, phone_normalized')
      .eq('account_id', accountId)
      .or(filters.join(','))
      .order('name', { ascending: true })
      .limit(MAX_RESULTS);
    if (error) throw error;

    const leads = ((data ?? []) as LeadSearchHit[]).slice(0, MAX_RESULTS);
    // Exactly one exact-digit hit → badge candidate. Zero or
    // several → null (ambiguous stays unbadged, never auto-picked).
    const exact = digits ? leads.filter((l) => l.phone_normalized === digits) : [];
    const exactMatchId = exact.length === 1 ? exact[0].id : null;

    return NextResponse.json({ leads, exactMatchId });
  } catch (err) {
    return toErrorResponse(err);
  }
}
