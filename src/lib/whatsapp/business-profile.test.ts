import { describe, expect, it } from "vitest";

import {
  buildBusinessProfileUpdate,
  businessProfileToForm,
  isValidHttpUrl,
  validateBusinessProfileForm,
  validateProfilePhoto,
  type BusinessProfileFormValues,
} from "./business-profile";
import type { BusinessProfile } from "./meta-api";

const PROFILE: BusinessProfile = {
  about: "Best trips",
  address: "1 Main St",
  description: "We plan trips.",
  email: "info@example.com",
  profile_picture_url: "https://cdn/pic.jpg",
  vertical: "TRAVEL",
  websites: ["https://example.com"],
};

const FORM: BusinessProfileFormValues = {
  about: "Best trips",
  address: "1 Main St",
  description: "We plan trips.",
  email: "info@example.com",
  vertical: "TRAVEL",
  website: "https://example.com",
  website2: "",
};

describe("businessProfileToForm", () => {
  it("maps nulls to empty strings and splits websites", () => {
    expect(
      businessProfileToForm({
        about: null,
        address: null,
        description: null,
        email: null,
        profile_picture_url: null,
        vertical: null,
        websites: [],
      }),
    ).toEqual({
      about: "",
      address: "",
      description: "",
      email: "",
      vertical: "",
      website: "",
      website2: "",
    });
    expect(businessProfileToForm(PROFILE)).toEqual(FORM);
  });
});

describe("validateBusinessProfileForm", () => {
  it("accepts a valid form", () => {
    expect(validateBusinessProfileForm(FORM)).toEqual({});
  });

  it("rejects bad email, URLs, lengths, and duplicate websites", () => {
    const bad = validateBusinessProfileForm({
      ...FORM,
      email: "not-an-email",
      website: "ftp://x",
      about: "a".repeat(513),
    });
    expect(bad.email).toBeTruthy();
    expect(bad.website).toBeTruthy();
    expect(bad.about).toBeTruthy();

    const dupes = validateBusinessProfileForm({
      ...FORM,
      website: "https://example.com",
      website2: "https://example.com",
    });
    expect(dupes.website2).toBeTruthy();
  });

  it("rejects unknown categories", () => {
    expect(
      validateBusinessProfileForm({ ...FORM, vertical: "MOON_BASE" }).vertical,
    ).toBeTruthy();
  });
});

describe("isValidHttpUrl", () => {
  it("allows empty (unset) and http(s)", () => {
    expect(isValidHttpUrl("")).toBe(true);
    expect(isValidHttpUrl("https://example.com/x")).toBe(true);
  });

  it("rejects javascript:, data:, and garbage", () => {
    expect(isValidHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isValidHttpUrl("data:text/plain,hi")).toBe(false);
    expect(isValidHttpUrl("not a url")).toBe(false);
  });
});

describe("buildBusinessProfileUpdate", () => {
  it("returns no keys when nothing changed", () => {
    expect(buildBusinessProfileUpdate(PROFILE, FORM)).toEqual({});
  });

  it("sends only changed fields", () => {
    expect(
      buildBusinessProfileUpdate(PROFILE, { ...FORM, about: "New tagline" }),
    ).toEqual({ about: "New tagline" });
  });

  it("maps cleared text to null and splits websites", () => {
    expect(
      buildBusinessProfileUpdate(PROFILE, {
        ...FORM,
        description: "  ",
        website2: "https://shop.example.com",
      }),
    ).toEqual({
      description: null,
      websites: ["https://example.com", "https://shop.example.com"],
    });
  });

  it("omits websites when unchanged, even reordered-empty", () => {
    const update = buildBusinessProfileUpdate(
      { ...PROFILE, websites: [] },
      { ...FORM, website: "", website2: "" },
    );
    expect("websites" in update).toBe(false);
  });
});

describe("validateProfilePhoto", () => {
  it("accepts JPEG/PNG within budget", () => {
    expect(
      validateProfilePhoto({ mimeType: "image/jpeg", sizeBytes: 1024 }),
    ).toBeNull();
    expect(
      validateProfilePhoto({ mimeType: "image/png", sizeBytes: 5 * 1024 * 1024 }),
    ).toBeNull();
  });

  it("rejects wrong types, empty, and oversized files", () => {
    expect(
      validateProfilePhoto({ mimeType: "image/webp", sizeBytes: 100 }),
    ).toBeTruthy();
    expect(
      validateProfilePhoto({ mimeType: "image/jpeg", sizeBytes: 0 }),
    ).toBeTruthy();
    expect(
      validateProfilePhoto({ mimeType: "image/png", sizeBytes: 6 * 1024 * 1024 }),
    ).toBeTruthy();
  });
});
