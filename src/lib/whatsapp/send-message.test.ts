import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  renderTemplateMessageText,
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// Hoisted capture for the persistence tests below.
const h = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  metaMediaCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: () => Promise.resolve({ messageId: 'wamid.text-9' }),
  sendTemplateMessage: () => Promise.resolve({ messageId: 'wamid.tpl-9' }),
  sendMediaMessage: (args: Record<string, unknown>) => {
    h.metaMediaCalls.push(args);
    return Promise.resolve({ messageId: 'wamid.media-9' });
  },
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (s: string) => s,
  isLegacyFormat: () => false,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ error: null }),
          }),
        }),
      }),
    }),
  }),
}));

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

describe('renderTemplateMessageText', () => {
  it('renders structured body values for API-sent templates', () => {
    expect(
      renderTemplateMessageText(
        'Hi {{1}}, your meeting is at {{2}}.',
        { body: ['Pintu', '8:30 pm'] },
        []
      )
    ).toBe('Hi Pintu, your meeting is at 8:30 pm.');
  });

  it('falls back to legacy body values and preserves missing placeholders', () => {
    expect(
      renderTemplateMessageText(
        'Hi {{1}}, code {{2}}.',
        undefined,
        ['Pintu']
      )
    ).toBe('Hi Pintu, code {{2}}.');
  });
});

describe('sendMessageToConversation — media reference persistence', () => {
  // Minimal chain fake: conversation+contact, config, message insert,
  // conversation touch-up. Anything else explodes loudly.
  function fakeDb() {
    const table = (name: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        single: async () => {
          if (name === 'conversations') {
            return {
              data: {
                id: 'cv-1',
                account_id: 'acct-1',
                contact: { id: 'ct-1', phone: '+15551234567' },
              },
              error: null,
            };
          }
          if (name === 'whatsapp_config') {
            return {
              data: {
                id: 'cfg-1',
                phone_number_id: 'pn-1',
                access_token: 'enc-token',
              },
              error: null,
            };
          }
          throw new Error(`unexpected single() on ${name}`);
        },
        insert: (payload: Record<string, unknown>) => {
          h.inserts.push({ table: name, payload });
          return {
            select: () => ({
              single: async () => ({ data: { id: 'm-1' }, error: null }),
            }),
          };
        },
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
      return b;
    };
    return { from: (name: string) => table(name) } as unknown as SupabaseClient;
  }

  beforeEach(() => {
    h.inserts = [];
    h.metaMediaCalls = [];
  });

  it('persists media_url + filename for a manual document send', async () => {
    const result = await sendMessageToConversation(fakeDb(), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'document',
      contentText: 'Q3 report',
      mediaUrl: 'https://storage.example/chat-media/q3.pdf',
      filename: 'q3-report.pdf',
    });

    expect(result.whatsappMessageId).toBe('wamid.media-9');
    // Meta got the link + filename…
    expect(h.metaMediaCalls).toHaveLength(1);
    expect(h.metaMediaCalls[0]).toMatchObject({
      kind: 'document',
      link: 'https://storage.example/chat-media/q3.pdf',
      filename: 'q3-report.pdf',
    });
    // …and the DB kept the reference (not the bytes) for the Inbox.
    const stored = h.inserts.find((i) => i.table === 'messages');
    expect(stored?.payload).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'agent',
      content_type: 'document',
      content_text: 'Q3 report',
      media_url: 'https://storage.example/chat-media/q3.pdf',
      media_file_name: 'q3-report.pdf',
      message_id: 'wamid.media-9',
      status: 'sent',
    });
  });

  it('stores a null filename when the send carries none', async () => {
    await sendMessageToConversation(fakeDb(), 'acct-1', {
      conversationId: 'cv-1',
      messageType: 'image',
      contentText: 'Look!',
      mediaUrl: 'https://storage.example/chat-media/pic.jpg',
    });

    const stored = h.inserts.find((i) => i.table === 'messages');
    expect(stored?.payload).toMatchObject({
      content_type: 'image',
      media_url: 'https://storage.example/chat-media/pic.jpg',
      media_file_name: null,
    });
  });
});
