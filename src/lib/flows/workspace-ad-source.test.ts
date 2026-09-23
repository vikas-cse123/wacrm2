import { describe, expect, it } from "vitest";
import {
  adSourceLabel,
  adSourcePlatform,
  toSafeAdSourceHref,
} from "./workspace-ad-source";

describe("adSourcePlatform", () => {
  it("detects Facebook URLs", () => {
    expect(adSourcePlatform("https://fb.me/9NXAdJ5P2")).toBe("facebook");
    expect(adSourcePlatform("https://facebook.com/ads/123")).toBe("facebook");
    expect(adSourcePlatform("fb.me/50EJ17fxE")).toBe("facebook");
    expect(adSourcePlatform("https://www.facebook.com/x")).toBe("facebook");
  });

  it("detects Instagram URLs", () => {
    expect(adSourcePlatform("https://instagram.com/p/ABC123")).toBe("instagram");
    expect(adSourcePlatform("instagram.com/p/DdN9fIuxAW1V")).toBe("instagram");
  });

  it("falls back safely for unknown, empty, and invalid values", () => {
    expect(adSourcePlatform("https://example.com/landing")).toBe("other");
    expect(adSourcePlatform(null)).toBeNull();
    expect(adSourcePlatform(undefined)).toBeNull();
    expect(adSourcePlatform("")).toBeNull();
    expect(adSourcePlatform("   ")).toBeNull();
    expect(adSourcePlatform("not a url at all")).toBeNull();
  });

  it("never mistakes bare words for platforms", () => {
    expect(adSourcePlatform("No Ad")).toBeNull();
    expect(adSourcePlatform("facebook")).toBeNull();
  });
});

describe("toSafeAdSourceHref", () => {
  it("preserves exact stored https URLs", () => {
    expect(toSafeAdSourceHref("https://fb.me/9NXAdJ5P2")).toBe(
      "https://fb.me/9NXAdJ5P2",
    );
    expect(toSafeAdSourceHref("https://instagram.com/p/ABC123")).toBe(
      "https://instagram.com/p/ABC123",
    );
  });

  it("upgrades protocol-less URLs to https", () => {
    expect(toSafeAdSourceHref("fb.me/874neIpU9")).toBe("https://fb.me/874neIpU9");
    expect(toSafeAdSourceHref("instagram.com/p/DcnuXje9Veg")).toBe(
      "https://instagram.com/p/DcnuXje9Veg",
    );
  });

  it("rejects unsafe schemes and non-links", () => {
    expect(toSafeAdSourceHref("javascript:alert(1)")).toBeNull();
    expect(toSafeAdSourceHref("data:text/html,x")).toBeNull();
    expect(toSafeAdSourceHref("ftp://example.com/f")).toBeNull();
    expect(toSafeAdSourceHref(null)).toBeNull();
    expect(toSafeAdSourceHref("")).toBeNull();
    expect(toSafeAdSourceHref("No Ad")).toBeNull();
  });

  it("labels platforms for assistive technology", () => {
    expect(adSourceLabel("facebook")).toBe("Open Facebook ad");
    expect(adSourceLabel("instagram")).toBe("Open Instagram ad");
    expect(adSourceLabel("other")).toBe("Open ad source");
  });
});
