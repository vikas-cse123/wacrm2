import { describe, expect, it } from "vitest";

import { isValidEmail, sanitizeHeaderLine } from "./validate";

describe("isValidEmail", () => {
  it("accepts normal addresses", () => {
    expect(isValidEmail("sales@agency.com")).toBe(true);
    expect(isValidEmail("a.b+c@sub.domain.co.uk")).toBe(true);
  });

  it("rejects garbage", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false);
    expect(isValidEmail("a@b@c.com")).toBe(false);
    expect(isValidEmail("@missing.com")).toBe(false);
  });

  it("rejects addresses longer than RFC 5321's 254-char limit", () => {
    expect(isValidEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });
});

describe("sanitizeHeaderLine", () => {
  it("strips CR, LF and NUL so a value can't inject extra headers", () => {
    expect(sanitizeHeaderLine("Hello\r\nBcc: victim@evil.com")).toBe(
      "Hello  Bcc: victim@evil.com",
    );
    expect(sanitizeHeaderLine("Hello\nBcc: victim@evil.com")).toBe(
      "Hello Bcc: victim@evil.com",
    );
    expect(sanitizeHeaderLine("a\x00b")).toBe("a b");
  });

  it("leaves normal text untouched", () => {
    expect(sanitizeHeaderLine("New lead: Priya")).toBe("New lead: Priya");
  });
});