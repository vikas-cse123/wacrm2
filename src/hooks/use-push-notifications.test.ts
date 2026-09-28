import { describe, expect, it } from "vitest";

import {
  shouldResubscribeForVapid,
  vapidFingerprint,
} from "./use-push-notifications";

const KEY_A = "BElHk_8mY...vapid-public-key-A";
const KEY_B = "BElHk_9nZ...vapid-public-key-B";

describe("vapidFingerprint", () => {
  it("is a stable trimmed form of the public key", () => {
    expect(vapidFingerprint("  abcd  ")).toBe("abcd");
    expect(vapidFingerprint("abcd")).toBe(vapidFingerprint("abcd"));
  });
});

describe("shouldResubscribeForVapid", () => {
  it("reuses a subscription whose fingerprint matches the current key", () => {
    expect(shouldResubscribeForVapid(KEY_A, KEY_A)).toBe(false);
  });

  it("recreates a subscription when the VAPID key changed since it was created", () => {
    expect(shouldResubscribeForVapid(KEY_A, KEY_B)).toBe(true);
  });

  it("reuses a legacy subscription with no recorded fingerprint (no churn)", () => {
    expect(shouldResubscribeForVapid(null, KEY_A)).toBe(false);
    expect(shouldResubscribeForVapid("", KEY_A)).toBe(false);
  });
});