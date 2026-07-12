import { describe, expect, it } from "vitest";

import { buildPreview } from "./send";

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
