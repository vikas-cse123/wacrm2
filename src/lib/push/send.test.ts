import { describe, expect, it } from "vitest";

import {
  buildPreview,
  classifySendError,
  retryDelayMs,
  shortDeviceId,
} from "./send";

describe("buildPreview", () => {
  it("returns an empty string for nullish input", () => {
    expect(buildPreview(null)).toBe("");
    expect(buildPreview(undefined)).toBe("");
    expect(buildPreview("")).toBe("");
  });

  it("passes short text through untouched (trimmed)", () => {
    expect(buildPreview("  hello there  ")).toBe("hello there");
  });

  it("returns text at exactly the limit unchanged", () => {
    const text = "a".repeat(120);
    expect(buildPreview(text)).toBe(text);
  });

  it("truncates long text and appends an ellipsis", () => {
    const text = "a".repeat(200);
    const out = buildPreview(text);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(121);
  });

  it("prefers to break on a word boundary", () => {
    const text = `${"word ".repeat(30)}tail`;
    const out = buildPreview(text, 40);
    // Should not cut mid-word: the char before the ellipsis is a letter
    // that completes a whole "word".
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
  });

  it("falls back to a hard cut when there's no early space", () => {
    const text = "x".repeat(50);
    const out = buildPreview(text, 20);
    expect(out).toBe(`${"x".repeat(20)}…`);
  });

  it("respects a custom max length", () => {
    expect(buildPreview("hello world", 5)).toBe("hello…");
  });
});

describe("shortDeviceId", () => {
  it("returns a short stable prefix of the subscription row id", () => {
    expect(shortDeviceId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "a1b2c3d4",
    );
    expect(shortDeviceId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      shortDeviceId("a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
    );
  });

  it("never leaks the full endpoint in the short form", () => {
    const full = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(shortDeviceId(full).length).toBeLessThan(full.length);
  });
});

describe("classifySendError", () => {
  const withStatus = (status: number) =>
    Object.assign(new Error(`http ${status}`), { statusCode: status });

  it("classifies 404/410 as dead (prune)", () => {
    expect(classifySendError(withStatus(404))).toMatchObject({ kind: "dead", status: 404 });
    expect(classifySendError(withStatus(410))).toMatchObject({ kind: "dead", status: 410 });
  });

  it("classifies 401/403 as invalid (endpoint-specific auth rejection)", () => {
    expect(classifySendError(withStatus(401))).toMatchObject({ kind: "invalid", status: 401 });
    expect(classifySendError(withStatus(403))).toMatchObject({ kind: "invalid", status: 403 });
  });

  it("classifies 429 and 5xx as transient (retryable)", () => {
    expect(classifySendError(withStatus(429))).toMatchObject({ kind: "transient", status: 429 });
    expect(classifySendError(withStatus(502))).toMatchObject({ kind: "transient", status: 502 });
    expect(classifySendError(withStatus(500))).toMatchObject({ kind: "transient", status: 500 });
  });

  it("classifies a socket timeout as timeout (kept, not retried)", () => {
    expect(classifySendError(new Error("Socket timeout"))).toMatchObject({ kind: "timeout" });
  });

  it("classifies network failures as transient (retryable)", () => {
    expect(classifySendError(new Error("fetch failed"))).toMatchObject({ kind: "transient" });
    expect(classifySendError(new Error("socket hang up"))).toMatchObject({ kind: "transient" });
  });

  it("treats other 4xx as permanent errors (kept, not retried)", () => {
    expect(classifySendError(withStatus(400))).toMatchObject({ kind: "error" });
    expect(classifySendError(new Error("boom"))).toMatchObject({ kind: "error" });
  });
});

describe("retryDelayMs", () => {
  it("returns a bounded non-negative delay", () => {
    for (const attempt of [0, 1, 2]) {
      const delay = retryDelayMs(attempt);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it("grows with attempt count (exponential base)", () => {
    const first = retryDelayMs(0);
    const second = retryDelayMs(1);
    // second ≈ 2× base + jitter; must be strictly larger than first's base.
    expect(second).toBeGreaterThan(first);
  });
});
