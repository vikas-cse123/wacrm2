import { describe, expect, it } from 'vitest';

import { getOrCreateConversation } from './get-or-create';

// ------------------------------------------------------------
// In-memory Supabase mock that faithfully reproduces the
// Postgres behavior the fix relies on:
//  - SELECT sees only committed rows (simulated with a delay so
//    N parallel callers all observe "no row" before any INSERT
//    commits — the exact production race window).
//  - INSERT is atomic: the first committer wins; later committers
//    get a 23505 unique violation when the (account, contact)
//    pair already exists (migration 062).
// ------------------------------------------------------------

type Row = {
  id: string;
  account_id: string;
  contact_id: string;
  user_id: string;
  status: string;
  created_at: string;
};

function makeRaceDb(delayMs = 5) {
  const store = new Map<string, Row>();
  let seq = 0;
  let selectCalls = 0;
  let insertAttempts = 0;
  let insertWins = 0;

  const keyOf = (accountId: string, contactId: string) =>
    `${accountId}:${contactId}`;

  const db = {
    stats: {
      get selectCalls() {
        return selectCalls;
      },
      get insertAttempts() {
        return insertAttempts;
      },
      get insertWins() {
        return insertWins;
      },
      size() {
        return store.size;
      },
    },
    // Expose store for test setup (e.g. pre-existing closed thread).
    seed(row: Row) {
      store.set(keyOf(row.account_id, row.contact_id), row);
    },
    from(table: string) {
      if (table !== 'conversations') throw new Error(`unexpected table ${table}`);
      let mode: 'select' | 'insert' = 'select';
      let accountId = '';
      let contactId = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let insertRow: any = null;

      const builder = {
        select: () => builder,
        insert: (row: unknown) => {
          mode = 'insert';
          insertRow = row;
          return builder;
        },
        eq: (col: string, val: string) => {
          if (col === 'account_id') accountId = val;
          if (col === 'contact_id') contactId = val;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          selectCalls++;
          await new Promise((r) => setTimeout(r, delayMs));
          const row = store.get(keyOf(accountId, contactId)) ?? null;
          return { data: row, error: null };
        },
        single: async () => {
          if (mode !== 'insert') throw new Error('single() only mocks insert path');
          insertAttempts++;
          // Race window: every caller already did its SELECT; now
          // serialize the commits. Only the first wins.
          await new Promise((r) => setTimeout(r, delayMs));
          const key = keyOf(
            (insertRow as Row).account_id,
            (insertRow as Row).contact_id,
          );
          if (store.has(key)) {
            return { data: null, error: { code: '23505', message: 'duplicate' } };
          }
          seq++;
          const row: Row = {
            id: `conv-${seq}`,
            account_id: (insertRow as Row).account_id,
            contact_id: (insertRow as Row).contact_id,
            user_id: (insertRow as Row).user_id,
            status: 'open',
            created_at: new Date().toISOString(),
          };
          store.set(key, row);
          insertWins++;
          return { data: row, error: null };
        },
      };
      return builder;
    },
  };
  return db;
}

describe('getOrCreateConversation concurrency', () => {
  it('N simultaneous requests for the same account/contact yield exactly ONE conversation', async () => {
    const db = makeRaceDb();
    const N = 20;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        getOrCreateConversation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          db as any,
          'acct-5921',
          'contact-cf2b',
          `audit-user-${i}`,
        ),
      ),
    );

    for (const r of results) {
      expect(r).not.toBeNull();
    }
    const ids = new Set(results.map((r) => r!.conversation.id));
    expect(ids.size).toBe(1);
    expect(db.stats.size()).toBe(1);
    // Exactly one INSERT won; the other 19 hit 23505 and re-read.
    expect(db.stats.insertWins).toBe(1);

    // Exactly one caller reports created:true, the rest reused.
    const createdCount = results.filter((r) => r!.created).length;
    expect(createdCount).toBe(1);
  });

  it('reuses the existing thread without inserting', async () => {
    const db = makeRaceDb(0);
    db.seed({
      id: 'conv-existing',
      account_id: 'acct-a',
      contact_id: 'contact-c',
      user_id: 'owner',
      status: 'open',
      created_at: new Date().toISOString(),
    });

    const res = await getOrCreateConversation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      'acct-a',
      'contact-c',
      'owner',
    );
    expect(res?.conversation.id).toBe('conv-existing');
    expect(res?.created).toBe(false);
    expect(db.stats.insertAttempts).toBe(0);
  });

  it('reuses a CLOSED conversation (no fork after close)', async () => {
    const db = makeRaceDb(0);
    db.seed({
      id: 'conv-closed',
      account_id: 'acct-a',
      contact_id: 'contact-c',
      user_id: 'owner',
      status: 'closed',
      created_at: new Date().toISOString(),
    });

    const res = await getOrCreateConversation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      'acct-a',
      'contact-c',
      'owner',
    );
    expect(res?.conversation.id).toBe('conv-closed');
    expect(res?.created).toBe(false);
    expect(db.stats.size()).toBe(1);
  });

  it('keeps account isolation: same contact id in another account gets its own thread', async () => {
    const db = makeRaceDb(0);

    const a = await getOrCreateConversation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      'acct-1',
      'contact-same',
      'owner-1',
    );
    const b = await getOrCreateConversation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      'acct-2',
      'contact-same',
      'owner-2',
    );

    expect(a?.conversation.id).not.toBe(b?.conversation.id);
    expect(db.stats.size()).toBe(2);
  });
});
