import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Structural contract for the Calls period card: exactly the 9
// recording metrics in order — no call-log claims (Total Calls,
// Missed, Rejected, Working Hours, ...). Follows the repo's
// page-wiring assertion pattern.

const root = process.cwd();
const cardSrc = readFileSync(
  `${root}/src/components/calls/call-period-card.tsx`,
  "utf8",
);
const tileSrc = readFileSync(
  `${root}/src/components/calls/call-metric-tile.tsx`,
  "utf8",
);

const EXPECTED_LABELS = [
  "Recordings",
  "Recording Duration",
  "Incoming Recordings",
  "Outgoing Recordings",
  "Phone",
  "WhatsApp",
  "WhatsApp Business",
  "Unique Clients",
  "Unlinked Recordings",
];

const FORBIDDEN = [
  "Total Calls",
  "Call Duration",
  "Missed",
  "Rejected",
  "Never Attended",
  "Not Pickup by Client",
  "Connected Calls",
  "Working Hours",
];

describe("Calls period card metrics", () => {
  it("renders exactly the 9 recording metrics in order", () => {
    const labels = [...cardSrc.matchAll(/label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(EXPECTED_LABELS);
  });

  it("contains no true-call-analytics claims", () => {
    for (const label of FORBIDDEN) {
      expect(cardSrc).not.toContain(`"${label}"`);
    }
    expect(cardSrc).not.toContain("Hourglass");
  });

  it("uses WACRM card surfaces, not grey-box tiles", () => {
    expect(tileSrc).toContain("bg-card");
    expect(tileSrc).toContain("border-border");
    expect(tileSrc).not.toContain("bg-muted/60");
  });

  it("keeps the honest-unavailable contract on tiles", () => {
    expect(tileSrc).toContain("unavailableReason");
  });
});
