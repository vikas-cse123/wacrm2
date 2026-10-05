import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { matchContactByPhone } from './contact-matching';

function fakeClient(
  rows: Array<{ id: string }> | null,
  seen: { accountId?: unknown; normalized?: unknown },
  fail = false,
) {
  return {
    from: () => ({
      select: () => ({
        eq: (col: string, val: unknown) => {
          if (col === 'account_id') seen.accountId = val;
          return {
            eq: (col2: string, val2: unknown) => {
              if (col2 === 'phone_normalized') seen.normalized = val2;
              return {
                limit: async () => {
                  if (fail) return { data: null, error: { message: 'db down' } };
                  return { data: rows, error: null };
                },
              };
            },
          };
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('matchContactByPhone', () => {
  it('links on exactly one match, scoped to the account', async () => {
    const seen: Record<string, unknown> = {};
    const out = await matchContactByPhone(
      fakeClient([{ id: 'c-1' }], seen),
      'acct-A',
      '+91 91639 46425 16',
    );
    expect(out).toEqual({ kind: 'unique', contactId: 'c-1' });
    expect(seen.accountId).toBe('acct-A');
    expect(seen.normalized).toBe('91916394642516');
  });

  it('returns none on zero matches, ambiguity, blank input, and lookup errors', async () => {
    const seen: Record<string, unknown> = {};
    expect(
      await matchContactByPhone(fakeClient([], seen), 'acct-A', '+91111'),
    ).toEqual({ kind: 'none' });
    expect(
      await matchContactByPhone(
        fakeClient([{ id: 'c-1' }, { id: 'c-2' }], seen),
        'acct-A',
        '+91111',
      ),
    ).toEqual({ kind: 'ambiguous' });
    expect(
      await matchContactByPhone(fakeClient([{ id: 'c-1' }], seen), 'acct-A', '   '),
    ).toEqual({ kind: 'none' });
    expect(
      await matchContactByPhone(fakeClient(null, seen, true), 'acct-A', '+91111'),
    ).toEqual({ kind: 'none' });
  });
});
