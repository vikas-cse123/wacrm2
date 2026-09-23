import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Hoisted Meta mock so deliverBroadcast never hits the network. The
// per-test messageId is set via `mockMetaMessageId.value`.
const h = vi.hoisted(() => ({ messageId: 'wamid-test-1' }));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: () => Promise.resolve({ messageId: 'wamid.text-9' }),
  sendTemplateMessage: () => Promise.resolve({ messageId: h.messageId }),
  sendMediaMessage: () => Promise.resolve({ messageId: 'wamid.media-9' }),
}));

import {
  persistBroadcastOutboundMessage,
  renderTemplateMessageText,
} from './send-message';
import { deliverBroadcast, type BroadcastPlan } from './broadcast-core';
import type { MessageTemplate } from '@/types';

// ------------------------------------------------------------
// Minimal in-memory Supabase stub. Implements only the query
// shapes used by `getOrCreateConversation`,
// `persistBroadcastOutboundMessage`, `deliverBroadcast`, and the
// webhook's status mirror (`messages.update().eq('message_id', …)`).
// ------------------------------------------------------------
type Row = Record<string, unknown> & { id: string };

interface FakeStore {
  conversations: Row[];
  messages: Row[];
  broadcast_recipients: Row[];
  broadcasts: Row[];
}

function emptyStore(): FakeStore {
  return {
    conversations: [],
    messages: [],
    broadcast_recipients: [],
    broadcasts: [],
  };
}

let seq = 0;
function nid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function createFakeDb(store: FakeStore): SupabaseClient {
  const client = {
    from(table: keyof FakeStore) {
      const rows = store[table];
      return {
        select() {
          const filters: Array<(r: Row) => boolean> = [];
          const builder: Record<string, unknown> = {
            eq: (col: string, val: unknown) => {
              filters.push((r) => r[col] === val);
              return builder;
            },
            order: () => builder,
            limit: () => builder,
            maybeSingle: async () => ({
              data: rows.find((r) => filters.every((f) => f(r))) ?? null,
              error: null,
            }),
            single: async () => {
              const hit = rows.find((r) => filters.every((f) => f(r))) ?? null;
              return hit
                ? { data: hit, error: null }
                : {
                    data: null,
                    error: { message: 'no row', code: 'PGRST116' },
                  };
            },
          };
          return builder;
        },
        insert(payload: unknown) {
          const list = (Array.isArray(payload) ? payload : [payload]) as Array<
            Record<string, unknown>
          >;
          const created: Row[] = list.map((p) => ({
            id: nid(table),
            created_at: new Date().toISOString(),
            ...p,
          })) as Row[];
          rows.push(...created);
          // Thenable so both `.select().single()` and a bare awaited
          // `.select()` (createBroadcast's recipient insert) resolve.
          const thenable = Promise.resolve({
            data: created,
            error: null,
          }) as Promise<{
            data: Row[];
            error: null;
          }> &
            Record<string, unknown>;
          thenable.single = async () => ({
            data: created[0] ?? null,
            error: null,
          });
          return { select: () => thenable };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq: (col: string, val: unknown) => {
              for (const r of rows) {
                if (r[col] === val) Object.assign(r, patch);
              }
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return client as unknown as SupabaseClient;
}

/** The exact status-mirror query the Meta webhook runs. */
async function webhookStatusMirror(
  db: SupabaseClient,
  whatsappMessageId: string,
  status: string
): Promise<void> {
  const { error } = await (
    db as unknown as {
      from: (t: string) => {
        update: (p: Record<string, unknown>) => {
          eq: (c: string, v: unknown) => Promise<{ error: null }>;
        };
      };
    }
  )
    .from('messages')
    .update({ status })
    .eq('message_id', whatsappMessageId);
  expect(error).toBeNull();
}

const TEMPLATE_ROW = {
  body_text: 'Hi {{1}}, your order {{2}} is ready.',
} as unknown as MessageTemplate;

function baseParams(
  overrides: Partial<Parameters<typeof persistBroadcastOutboundMessage>[1]> = {}
) {
  return {
    accountId: 'acct-1',
    contactId: 'ct-1',
    auditUserId: 'user-1',
    templateName: 'order_update',
    renderedText: renderTemplateMessageText(TEMPLATE_ROW.body_text, undefined, [
      'Pintu',
      '#42',
    ]),
    whatsappMessageId: 'wamid-abc-1',
    ...overrides,
  };
}

function broadcastPlan(overrides: Partial<BroadcastPlan> = {}): BroadcastPlan {
  return {
    broadcastId: 'b-1',
    accountId: 'acct-1',
    auditUserId: 'user-1',
    templateName: 'order_update',
    templateLanguage: 'en_US',
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
    templateRow: TEMPLATE_ROW,
    planned: [
      {
        recipientRowId: 'rr-1',
        contactId: 'ct-1',
        phone: '+15551234567',
        params: ['Pintu', '#42'],
      },
    ],
    rejected: 0,
    ...overrides,
  };
}

beforeEach(() => {
  seq = 0;
  h.messageId = 'wamid-test-1';
});

describe('persistBroadcastOutboundMessage — inbox mirror', () => {
  it('creates a normal outbound template message on the contact conversation', async () => {
    const store = emptyStore();
    const db = createFakeDb(store);

    const res = await persistBroadcastOutboundMessage(db, baseParams());

    expect(res).not.toBeNull();
    expect(store.conversations).toHaveLength(1);
    const conv = store.conversations[0];
    expect(conv).toMatchObject({ account_id: 'acct-1', contact_id: 'ct-1' });

    expect(store.messages).toHaveLength(1);
    const msg = store.messages[0];
    expect(msg).toMatchObject({
      conversation_id: conv.id,
      sender_type: 'agent',
      content_type: 'template',
      content_text: 'Hi Pintu, your order #42 is ready.',
      template_name: 'order_update',
      message_id: 'wamid-abc-1',
      status: 'sent',
    });
    // Conversation preview follows the manual-send convention.
    expect(conv.last_message_text).toBe('Hi Pintu, your order #42 is ready.');
  });

  it('reuses the existing conversation instead of forking a duplicate', async () => {
    const store = emptyStore();
    store.conversations.push({
      id: 'conv-existing',
      account_id: 'acct-1',
      contact_id: 'ct-1',
      user_id: 'user-1',
    });
    const db = createFakeDb(store);

    await persistBroadcastOutboundMessage(db, baseParams());
    await persistBroadcastOutboundMessage(
      db,
      baseParams({ whatsappMessageId: 'wamid-abc-2' })
    );

    expect(store.conversations).toHaveLength(1);
    expect(store.conversations[0].id).toBe('conv-existing');
    expect(store.messages).toHaveLength(2);
    for (const m of store.messages) {
      expect(m.conversation_id).toBe('conv-existing');
    }
  });

  it('is idempotent on retry: same Meta id returns the existing row', async () => {
    const store = emptyStore();
    const db = createFakeDb(store);

    const first = await persistBroadcastOutboundMessage(db, baseParams());
    const second = await persistBroadcastOutboundMessage(db, baseParams());

    expect(store.messages).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('does not over-dedupe: a different Meta id creates a second row', async () => {
    const store = emptyStore();
    const db = createFakeDb(store);

    await persistBroadcastOutboundMessage(db, baseParams());
    await persistBroadcastOutboundMessage(
      db,
      baseParams({ whatsappMessageId: 'wamid-abc-2' })
    );

    expect(store.messages).toHaveLength(2);
  });

  it('keeps accounts isolated: same contact id under another account gets its own thread', async () => {
    const store = emptyStore();
    const db = createFakeDb(store);

    await persistBroadcastOutboundMessage(db, baseParams());
    await persistBroadcastOutboundMessage(
      db,
      baseParams({ accountId: 'acct-2', whatsappMessageId: 'wamid-other-1' })
    );

    expect(store.conversations).toHaveLength(2);
    const convA = store.conversations.find((c) => c.account_id === 'acct-1')!;
    const convB = store.conversations.find((c) => c.account_id === 'acct-2')!;
    expect(convA.id).not.toBe(convB.id);
    expect(
      store.messages.find((m) => m.message_id === 'wamid-abc-1')!
        .conversation_id
    ).toBe(convA.id);
    expect(
      store.messages.find((m) => m.message_id === 'wamid-other-1')!
        .conversation_id
    ).toBe(convB.id);
  });

  it('never throws: a DB failure resolves to null (Meta send already succeeded)', async () => {
    const dead = {
      from() {
        throw new Error('db down');
      },
    } as unknown as SupabaseClient;

    await expect(
      persistBroadcastOutboundMessage(dead, baseParams())
    ).resolves.toBeNull();
  });
});

describe('webhook correlation — status events land on the SAME row', () => {
  it('delivered → read advance the broadcast-created message without duplicating', async () => {
    const store = emptyStore();
    const db = createFakeDb(store);

    const created = await persistBroadcastOutboundMessage(db, baseParams());
    expect(created).not.toBeNull();

    await webhookStatusMirror(db, 'wamid-abc-1', 'delivered');
    await webhookStatusMirror(db, 'wamid-abc-1', 'read');

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      id: created!.messageId,
      message_id: 'wamid-abc-1',
      status: 'read',
    });
  });

  it('a failed event marks the same row failed', async () => {
    const store = emptyStore();
    const db = createFakeDb(store);

    const created = await persistBroadcastOutboundMessage(db, baseParams());

    await webhookStatusMirror(db, 'wamid-abc-1', 'failed');

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      id: created!.messageId,
      status: 'failed',
    });
  });

  it('a duplicate webhook replay does not create another message', async () => {
    const store = emptyStore();
    const db = createFakeDb(store);

    await persistBroadcastOutboundMessage(db, baseParams());

    await webhookStatusMirror(db, 'wamid-abc-1', 'delivered');
    await webhookStatusMirror(db, 'wamid-abc-1', 'delivered');

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].status).toBe('delivered');
  });
});

describe('deliverBroadcast — analytics preserved + inbox mirrored', () => {
  it('stamps broadcast_recipients, finalizes the broadcast, and mirrors one inbox row', async () => {
    const store = emptyStore();
    store.broadcasts.push({ id: 'b-1', status: 'sending' });
    store.broadcast_recipients.push({ id: 'rr-1', status: 'pending' });
    const db = createFakeDb(store);

    await deliverBroadcast(db, broadcastPlan());

    // Analytics path untouched: recipient stamped with the Meta id…
    expect(store.broadcast_recipients[0]).toMatchObject({
      status: 'sent',
      whatsapp_message_id: 'wamid-test-1',
    });
    // …and the parent broadcast finalized.
    expect(store.broadcasts[0].status).toBe('sent');

    // Inbox path: exactly one normal outbound template message…
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      sender_type: 'agent',
      content_type: 'template',
      template_name: 'order_update',
      content_text: 'Hi Pintu, your order #42 is ready.',
      message_id: 'wamid-test-1',
      status: 'sent',
    });
    // …on the recipient contact's conversation in the right account.
    const conv = store.conversations.find(
      (c) => c.id === (store.messages[0].conversation_id as string)
    )!;
    expect(conv).toMatchObject({ account_id: 'acct-1', contact_id: 'ct-1' });

    // A later Meta delivery webhook updates that SAME row.
    await webhookStatusMirror(db, 'wamid-test-1', 'delivered');
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].status).toBe('delivered');
  });

  it('a retried fan-out with the same Meta id does not duplicate the inbox row', async () => {
    const store = emptyStore();
    store.broadcasts.push({ id: 'b-1', status: 'sending' });
    store.broadcast_recipients.push({ id: 'rr-1', status: 'pending' });
    const db = createFakeDb(store);

    await deliverBroadcast(db, broadcastPlan());
    await deliverBroadcast(db, broadcastPlan());

    expect(store.messages).toHaveLength(1);
  });
});
