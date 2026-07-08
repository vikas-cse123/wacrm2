import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaWebhookSignature } from "./webhook-signature";

const SECRET = process.env.META_APP_SECRET!;

function signedHeader(body: string, secret: string = SECRET): string {
  const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}

describe("verifyMetaWebhookSignature", () => {
  it("accepts a request signed with the correct secret", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    expect(verifyMetaWebhookSignature(body, signedHeader(body), SECRET)).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const body = "{}";
    expect(verifyMetaWebhookSignature(body, signedHeader(body, "wrong"), SECRET)).toBe(false);
  });

  it("rejects when the body has been tampered with after signing", () => {
    const original = '{"entry":[]}';
    const header = signedHeader(original);
    const tampered = '{"entry":[{"id":"injected"}]}';
    expect(verifyMetaWebhookSignature(tampered, header, SECRET)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyMetaWebhookSignature("anything", null, SECRET)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const body = "{}";
    const hex = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyMetaWebhookSignature(body, hex, SECRET)).toBe(false);
    expect(verifyMetaWebhookSignature(body, `sha512=${hex}`, SECRET)).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    expect(verifyMetaWebhookSignature("{}", "sha256=tooshort", SECRET)).toBe(false);
  });

  describe("fail-closed when secret is missing", () => {
    it("rejects even a correctly-formed signature when no secret is resolved", () => {
      const body = "{}";
      const header = signedHeader(body, SECRET);
      expect(verifyMetaWebhookSignature(body, header, null)).toBe(false);
      expect(verifyMetaWebhookSignature(body, header, "")).toBe(false);
    });
  });
});