import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendReminderToAgent } from "./reminder-send";
import { SendMessageError } from "@/lib/whatsapp/send-message";

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  failMeta: false,
  config: {
    phone_number_id: "pn-business-1",
    access_token: "enc-token",
  } as Record<string, unknown> | null,
  tablesRead: [] as string[],
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (ciphertext: string) => `decrypted(${ciphertext})`,
  encrypt: (s: string) => s,
  isLegacyFormat: () => false,
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTextMessage: async (args: Record<string, unknown>) => {
    h.calls.push(args);
    if (h.failMeta) throw new Error("Meta rejected the send");
    return { messageId: "wamid-abc" };
  },
}));

function fakeDb() {
  const api: Record<string, unknown> = {};
  api.from = (table: string) => {
    h.tablesRead.push(table);
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.maybeSingle = async () => ({ data: h.config, error: null });
    return q;
  };
  return api;
}

beforeEach(() => {
  h.calls = [];
  h.failMeta = false;
  h.tablesRead = [];
  h.config = { phone_number_id: "pn-business-1", access_token: "enc-token" };
});

describe("sendReminderToAgent", () => {
  it("sends FROM the business number TO the explicit recipient", async () => {
    const res = await sendReminderToAgent(fakeDb() as never, "acct-1", {
      to: "919876543210",
      text: "Call Rahul about Singapore package",
    });
    expect(res).toMatchObject({ whatsappMessageId: "wamid-abc" });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      // Sender = connected business number (URL path identity).
      phoneNumberId: "pn-business-1",
      // Auth = decrypted account access token.
      accessToken: "decrypted(enc-token)",
      // Destination = the passed snapshot, verbatim.
      to: "919876543210",
      text: "Call Rahul about Singapore package",
    });
  });

  it("only ever reads the sender config — never customer data", async () => {
    await sendReminderToAgent(fakeDb() as never, "acct-1", {
      to: "919876543210",
      text: "Hi",
    });
    expect(h.tablesRead).toEqual(["whatsapp_config"]);
  });

  it("fails when WhatsApp is not configured", async () => {
    h.config = null;
    await expect(
      sendReminderToAgent(fakeDb() as never, "acct-1", {
        to: "919876543210",
        text: "Hi",
      }),
    ).rejects.toMatchObject({ code: "whatsapp_not_configured" });
    expect(h.calls).toHaveLength(0);
  });

  it("wraps Meta failures without sending twice", async () => {
    h.failMeta = true;
    const err = await sendReminderToAgent(fakeDb() as never, "acct-1", {
      to: "919876543210",
      text: "Hi",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect((err as SendMessageError).code).toBe("meta_error");
    expect(h.calls).toHaveLength(1);
  });

  it("rejects empty recipient or text before touching Meta", async () => {
    await expect(
      sendReminderToAgent(fakeDb() as never, "acct-1", { to: "", text: "Hi" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      sendReminderToAgent(fakeDb() as never, "acct-1", {
        to: "919876543210",
        text: "",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(h.calls).toHaveLength(0);
  });
});
