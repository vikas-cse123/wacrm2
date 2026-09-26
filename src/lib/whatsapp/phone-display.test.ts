import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  displayToCanonicalPhone,
  formatPhoneForDisplay,
  isIndianCountryCodeNumber,
  normalizePhone,
} from "./phone-utils";
import { seedValues } from "@/components/workspace/travel-crm-action";

// ---------------------------------------------------------------------------
// Indian +91 display rule — DISPLAY ONLY. Canonical values (storage,
// WhatsApp messaging, matching, search, Travel CRM payloads) never
// change; only the Workspace column and the dialog field render the
// 10-digit form. Realistic fixtures per spec.
// ---------------------------------------------------------------------------

const INDIAN_CANONICAL = "919890431234";
const INDIAN_DISPLAY = "9890431234";
const NON_INDIAN = "971501234567";

describe("isIndianCountryCodeNumber (strict gate)", () => {
  it("matches only 91 + exactly 10 digits", () => {
    expect(isIndianCountryCodeNumber("+919890431234")).toBe(true);
    expect(isIndianCountryCodeNumber("919890431234")).toBe(true);
    expect(isIndianCountryCodeNumber("+91 98904 31234")).toBe(true);
    expect(isIndianCountryCodeNumber("971501234567")).toBe(false);
    expect(isIndianCountryCodeNumber("+447911123456")).toBe(false);
  });

  it("4. rejects short, long, non-numeric, and empty values", () => {
    expect(isIndianCountryCodeNumber("91123")).toBe(false);
    expect(isIndianCountryCodeNumber("91123456789012")).toBe(false);
    expect(isIndianCountryCodeNumber("ABC123")).toBe(false);
    expect(isIndianCountryCodeNumber("")).toBe(false);
    expect(isIndianCountryCodeNumber(null)).toBe(false);
    expect(isIndianCountryCodeNumber(undefined)).toBe(false);
  });
});

describe("formatPhoneForDisplay (display-only, canonical untouched)", () => {
  it("1. strips +91 to 10 digits", () => {
    expect(formatPhoneForDisplay("+919890431234")).toBe("9890431234");
  });

  it("2. strips bare 91 to 10 digits", () => {
    expect(formatPhoneForDisplay(INDIAN_CANONICAL)).toBe(INDIAN_DISPLAY);
  });

  it("3. non-Indian numbers keep their country code verbatim", () => {
    expect(formatPhoneForDisplay(NON_INDIAN)).toBe(NON_INDIAN);
    expect(formatPhoneForDisplay("+447911123456")).toBe("+447911123456");
  });

  it("4. invalid/ambiguous values render unchanged (never stripped)", () => {
    expect(formatPhoneForDisplay("91123")).toBe("91123");
    expect(formatPhoneForDisplay("91123456789012")).toBe("91123456789012");
    expect(formatPhoneForDisplay("call-91989-xyz")).toBe("call-91989-xyz");
    expect(formatPhoneForDisplay("")).toBe("");
    expect(formatPhoneForDisplay(null)).toBe("");
  });

  it("reuses the canonical normalizer (single source of truth)", () => {
    expect(normalizePhone("+91 98904-31234")).toBe(INDIAN_CANONICAL);
    const src = readFileSync(
      `${process.cwd()}/src/lib/whatsapp/phone-utils.ts`,
      "utf8",
    );
    expect(src).toContain("normalizePhone(value)");
  });
});

describe("6. dialog Phone field shows the display form", () => {
  it("seeds stripped for Indian, verbatim otherwise", () => {
    expect(seedValues({ phone: INDIAN_CANONICAL }).phone).toBe(INDIAN_DISPLAY);
    expect(seedValues({ phone: "+919890431234" }).phone).toBe(INDIAN_DISPLAY);
    expect(seedValues({ phone: NON_INDIAN }).phone).toBe(NON_INDIAN);
    expect(seedValues({})).not.toHaveProperty("phone");
  });
});

describe("7+8. edits map back to canonical for the payload", () => {
  it("edited stripped Indian number regains +91", () => {
    expect(displayToCanonicalPhone("9890431235", true)).toBe("919890431235");
  });

  it("untouched display round-trips to the stored canonical", () => {
    expect(displayToCanonicalPhone(INDIAN_DISPLAY, true)).toBe(INDIAN_CANONICAL);
  });

  it("full international entries are never double-prefixed", () => {
    expect(displayToCanonicalPhone("919890431235", true)).toBe("919890431235");
    expect(displayToCanonicalPhone(NON_INDIAN, false)).toBe(NON_INDIAN);
    expect(displayToCanonicalPhone("+971501234567", false)).toBe("+971501234567");
  });

  it("empty edits stay empty (existing skip behavior)", () => {
    expect(displayToCanonicalPhone("", true)).toBe("");
  });

  it("submit reconstructs canonical (wiring intact)", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/workspace/travel-crm-action.tsx`,
      "utf8",
    );
    expect(src).toContain("displayToCanonicalPhone(");
    expect(src).toContain("isIndianCountryCodeNumber(");
  });
});
