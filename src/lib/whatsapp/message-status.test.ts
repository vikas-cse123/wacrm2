import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isForwardMessageStatus,
  MESSAGE_STATUS_ORDER,
} from "./message-status";

// ---------------------------------------------------------------------------
// Forward-only message statuses: sending < sent < delivered < read.
// Late/duplicate Meta events must never regress a Seen bubble.
// ---------------------------------------------------------------------------

describe("isForwardMessageStatus", () => {
  it("follows the strict ladder sending < sent < delivered < read", () => {
    expect(MESSAGE_STATUS_ORDER).toEqual([
      "sending",
      "sent",
      "delivered",
      "read",
    ]);
    expect(isForwardMessageStatus("sending", "sent")).toBe(true);
    expect(isForwardMessageStatus("sent", "delivered")).toBe(true);
    expect(isForwardMessageStatus("delivered", "read")).toBe(true);
    expect(isForwardMessageStatus("sending", "read")).toBe(true);
  });

  it("blocks the reported regression: read never moves back", () => {
    expect(isForwardMessageStatus("read", "delivered")).toBe(false);
    expect(isForwardMessageStatus("read", "sent")).toBe(false);
    expect(isForwardMessageStatus("read", "sending")).toBe(false);
    expect(isForwardMessageStatus("delivered", "sent")).toBe(false);
    expect(isForwardMessageStatus("delivered", "delivered")).toBe(true);
    expect(isForwardMessageStatus("read", "read")).toBe(true);
  });

  it("treats failed as terminal truth (applies once)", () => {
    expect(isForwardMessageStatus("sent", "failed")).toBe(true);
    expect(isForwardMessageStatus("delivered", "failed")).toBe(true);
    expect(isForwardMessageStatus("failed", "failed")).toBe(false);
    expect(isForwardMessageStatus("failed", "read")).toBe(false);
  });

  it("fails open on unknown current, closed on unknown incoming", () => {
    expect(isForwardMessageStatus("mystery", "read")).toBe(true);
    expect(isForwardMessageStatus(null, "sent")).toBe(true);
    expect(isForwardMessageStatus("sent", "mystery")).toBe(false);
    expect(isForwardMessageStatus("sent", "")).toBe(false);
    expect(isForwardMessageStatus("sent", null)).toBe(false);
  });
});

describe("regression gates are wired (webhook + realtime)", () => {
  const root = process.cwd();

  it("webhook messages mirror filters by forward movement", () => {
    const src = readFileSync(
      `${root}/src/app/api/whatsapp/webhook/route.ts`,
      "utf8",
    );
    expect(src).toContain("isForwardMessageStatus(row.status, status.status)");
    // Blind overwrite is gone from the messages mirror.
    expect(src).not.toMatch(/\.update\(\{ status: status\.status \}\)\s*\n\s*\.eq\('message_id'/);
  });

  it("inbox realtime merge keeps newer status on stale events", () => {
    const src = readFileSync(
      `${root}/src/app/(dashboard)/inbox/page.tsx`,
      "utf8",
    );
    expect(src).toContain("isForwardMessageStatus(m.status, newMsg.status)");
  });
});
