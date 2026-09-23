import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_MESSAGE_MAX,
  isFollowupStatus,
  validateFollowupInput,
} from "./types";

const FUTURE = "2999-01-01T10:00:00.000Z";
const PAST = "2000-01-01T10:00:00.000Z";

describe("follow-up input validation", () => {
  it("accepts a future follow-up", () => {
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

  it("rejects past date/time", () => {
    expect(() =>
      validateFollowupInput({
        contact_id: "c-1",
        scheduled_for: PAST,
        message_text: "Hi",
      }),
    ).toThrow(/future/i);
  });

  it("requires date, time (as instant), contact, and message", () => {
    expect(() =>
      validateFollowupInput({ contact_id: "", scheduled_for: FUTURE, message_text: "Hi" }),
    ).toThrow(/contact/i);
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
