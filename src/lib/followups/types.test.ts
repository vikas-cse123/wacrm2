import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_MESSAGE_MAX,
  isFollowupStatus,
  normalizeRecipientPhone,
  validateFollowupInput,
} from "./types";

const FUTURE = "2999-01-01T10:00:00.000Z";
const PAST = "2000-01-01T10:00:00.000Z";

describe("reminder input validation", () => {
  it("accepts a future reminder with customer context", () => {
    const out = validateFollowupInput({
      contact_id: "c-1",
      scheduled_for: FUTURE,
      message_text: "  Hi there  ",
    });
    expect(out).toMatchObject({
      contact_id: "c-1",
      message_text: "Hi there",
      template_name: null,
    });
  });

  it("treats customer as optional context", () => {
    for (const contact_id of [undefined, null, ""]) {
      const out = validateFollowupInput({
        contact_id,
        scheduled_for: FUTURE,
        message_text: "Call the Dubai lead after lunch",
      });
      expect(out.contact_id).toBeNull();
    }
  });

  it("rejects past date/time", () => {
    expect(() =>
      validateFollowupInput({
        contact_id: "c-1",
        scheduled_for: PAST,
        message_text: "Hi",
      }),
    ).toThrow(/future/i);
  });

  it("requires date, time (as instant), and message — but not a customer", () => {
    expect(() =>
      validateFollowupInput({ contact_id: 123, scheduled_for: FUTURE, message_text: "Hi" }),
    ).toThrow(/customer/i);
    expect(() =>
      validateFollowupInput({ contact_id: "c-1", scheduled_for: "not-a-date", message_text: "Hi" }),
    ).toThrow(/valid date/i);
    expect(() =>
      validateFollowupInput({ contact_id: "c-1", scheduled_for: FUTURE, message_text: "  " }),
    ).toThrow(/message/i);
  });

  it("enforces the message length cap without modifying text", () => {
    const msg = "x".repeat(FOLLOWUP_MESSAGE_MAX);
    expect(
      validateFollowupInput({ contact_id: "c-1", scheduled_for: FUTURE, message_text: msg })
        .message_text,
    ).toBe(msg);
    expect(() =>
      validateFollowupInput({
        contact_id: "c-1",
        scheduled_for: FUTURE,
        message_text: `${msg}x`,
      }),
    ).toThrow(/characters/i);
  });

  it("accepts an optional template with language default", () => {
    const out = validateFollowupInput({
      contact_id: "c-1",
      scheduled_for: FUTURE,
      message_text: "Hi",
      template_name: "hello_world",
    });
    expect(out.template_name).toBe("hello_world");
    expect(out.template_language).toBe("en_US");
  });

  it("recognizes the five statuses", () => {
    for (const s of ["scheduled", "processing", "sent", "failed", "cancelled"]) {
      expect(isFollowupStatus(s)).toBe(true);
    }
    expect(isFollowupStatus("pending")).toBe(false);
  });
});

describe("normalizeRecipientPhone", () => {
  it("normalizes to digits-only E.164", () => {
    expect(normalizeRecipientPhone("+91 98765 43210")).toBe("919876543210");
    expect(normalizeRecipientPhone("+1 (415) 555-1212")).toBe("14155551212");
  });

  it("fails closed on anything else — never falls back", () => {
    expect(normalizeRecipientPhone(null)).toBeNull();
    expect(normalizeRecipientPhone(undefined)).toBeNull();
    expect(normalizeRecipientPhone("")).toBeNull();
    expect(normalizeRecipientPhone("   ")).toBeNull();
    expect(normalizeRecipientPhone("not a number")).toBeNull();
    expect(normalizeRecipientPhone("123")).toBeNull();
    expect(normalizeRecipientPhone(919876543210)).toBeNull();
  });
});
