import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared mock state — hoisted so the vi.mock factories can close over it.
const h = vi.hoisted(() => ({
  state: {
    messageInserts: [] as Record<string, unknown>[],
    metaButtonCalls: [] as Record<string, unknown>[],
    metaListCalls: [] as Record<string, unknown>[],
  },
}));

vi.mock("@/lib/whatsapp/meta-api", () => {
  const { state } = h;
  return {
    sendInteractiveButtons: (args: Record<string, unknown>) => {
      state.metaButtonCalls.push(args);
      return Promise.resolve({ messageId: "wamid.buttons-1" });
    },
    sendInteractiveList: (args: Record<string, unknown>) => {
      state.metaListCalls.push(args);
      return Promise.resolve({ messageId: "wamid.list-1" });
    },
    sendCtaUrl: () => Promise.resolve({ messageId: "wamid.cta-1" }),
    sendTextMessage: () => Promise.resolve({ messageId: "wamid.text-1" }),
    sendMediaMessage: () => Promise.resolve({ messageId: "wamid.media-1" }),
  };
});

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: () => "plain-token",
}));

vi.mock("./admin-client", () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
  }) {
    const { table, type } = ops;
    if (table === "contacts") {
      if (type === "update") return { data: null, error: null };
      return { data: { id: "c1", phone: "+15551234567" }, error: null };
    }
    if (table === "whatsapp_config") {
      return {
        data: { phone_number_id: "pn1", access_token: "enc-token" },
        error: null,
      };
    }
    if (table === "messages") {
      if (type === "insert") {
        state.messageInserts.push(ops.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: "select" as string,
      payload: undefined as unknown,
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = "update"), (ops.payload = p), b),
      eq: () => b,
      maybeSingle: () => Promise.resolve(resolve(ops)),
      single: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => builder(table),
    }),
  };
});

import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from "./meta-send";

const state = h.state;

function baseArgs() {
  return {
    accountId: "acc-1",
    userId: "u1",
    conversationId: "conv-1",
    contactId: "c1",
    bodyText: "What best describes your business?",
  };
}

describe("engineSendInteractiveButtons — interactive_buttons persistence", () => {
  beforeEach(() => {
    state.messageInserts = [];
    state.metaButtonCalls = [];
    state.metaListCalls = [];
  });

  it("persists interactive_buttons identical to the buttons sent to Meta", async () => {
    const buttons = [
      { id: "r1", title: "Travel Agency Owner" },
      { id: "r2", title: "Tour Operator" },
    ];
    await engineSendInteractiveButtons({ ...baseArgs(), buttons });

    // Meta received the expected buttons
    expect(state.metaButtonCalls).toHaveLength(1);
    expect(state.metaButtonCalls[0].bodyText).toBe(
      "What best describes your business?",
    );
    expect(state.metaButtonCalls[0].buttons).toEqual(buttons);

    // The DB insert carries the exact same ids/titles
    expect(state.messageInserts).toHaveLength(1);
    const row = state.messageInserts[0];
    expect(row.sender_type).toBe("bot");
    expect(row.content_type).toBe("interactive");
    expect(row.content_text).toBe("What best describes your business?");
    expect(row.interactive_buttons).toEqual([
      { id: "r1", title: "Travel Agency Owner" },
      { id: "r2", title: "Tour Operator" },
    ]);
    // The customer's tap column stays untouched
    expect(row.interactive_reply_id).toBeUndefined();
  });

  it("preserves ids, titles, and ordering for a three-button message", async () => {
    const buttons = [
      { id: "reply_travel", title: "Travel Agency Owner" },
      { id: "reply_tour", title: "Tour Operator" },
      { id: "reply_cab", title: "Cab services" },
    ];
    await engineSendInteractiveButtons({ ...baseArgs(), buttons });

    const sent = state.metaButtonCalls[0].buttons as Array<{
      id: string;
      title: string;
    }>;
    const stored = state.messageInserts[0].interactive_buttons as Array<{
      id: string;
      title: string;
    }>;
    expect(stored).toEqual(sent);
    expect(stored.map((b) => b.id)).toEqual([
      "reply_travel",
      "reply_tour",
      "reply_cab",
    ]);
    expect(stored.map((b) => b.title)).toEqual([
      "Travel Agency Owner",
      "Tour Operator",
      "Cab services",
    ]);
  });

  it("interactive list messages do NOT store interactive_buttons", async () => {
    await engineSendInteractiveList({
      ...baseArgs(),
      buttonLabel: "Choose",
      sections: [
        { rows: [{ id: "row1", title: "Row 1", description: "d" }] },
      ],
    });

    expect(state.metaListCalls).toHaveLength(1);
    expect(state.messageInserts).toHaveLength(1);
    const row = state.messageInserts[0];
    expect(row.content_type).toBe("interactive");
    expect(row.sender_type).toBe("bot");
    expect(row).not.toHaveProperty("interactive_buttons");
  });
});
