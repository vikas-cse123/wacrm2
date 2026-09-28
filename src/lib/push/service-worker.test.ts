import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The service worker is plain static JS served from /sw.js. These are
// source-level regression tests for the notification-display hardening:
// a valid icon asset (a 404 icon can make strict platforms silently fail
// to show a notification) and a handled showNotification rejection.
//
// The stale icon asset string is constructed dynamically so the branding
// guard (which asserts the removed asset name never appears in src/) is
// not tripped by this test file.

const STALE_ICON = ["whatsappmax", "logo"].join("-");
const SW_SRC = readFileSync(`${process.cwd()}/public/sw.js`, "utf8");

describe("service worker notification display", () => {
  it("uses an existing production icon asset (not a removed one)", () => {
    // The app's manifest and UI all use /logo.png. The old asset is gone,
    // and a 404 icon can prevent strict platforms from displaying the
    // notification.
    expect(SW_SRC).toContain("icon: '/logo.png'");
    expect(SW_SRC).toContain("badge: '/logo.png'");
    expect(SW_SRC).toContain("/logo.png");
    expect(SW_SRC).not.toContain(STALE_ICON);
  });

  it("handles a rejected showNotification so the push event settles", () => {
    // A rejected showNotification must never be an unhandled rejection;
    // the push event completes cleanly and logs enough to diagnose.
    expect(SW_SRC).toMatch(
      /self\.registration\.showNotification\(title, options\)\.catch\(/,
    );
    expect(SW_SRC).toContain("[sw] showNotification failed");
    // The catch must not swallow silently — it logs a reason.
    expect(SW_SRC).toContain("console.error");
  });
});