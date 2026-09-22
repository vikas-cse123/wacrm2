// ---------------------------------------------------------------------------
// Tests for the Copy Flow dialog helpers.
//
// The dialog component itself needs a DOM and is covered by review;
// everything decision-shaped lives in pure helpers tested here:
// destination routing, success/error copy, warning mapping, and the
// hard rule that no UI string mentions cross-account mechanics.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatCopyError,
  formatCopySuccess,
  formatCopyWarning,
  resolveCopyDestination,
} from "./copy-flow-dialog";

const SELF = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("resolveCopyDestination", () => {
  it("routes the current account to the existing same-account behavior", () => {
    expect(resolveCopyDestination(SELF, SELF)).toEqual({
      kind: "same",
      accountId: SELF,
    });
  });

  it("routes any other account to the internal endpoint", () => {
    expect(resolveCopyDestination(OTHER, SELF)).toEqual({
      kind: "other",
      accountId: OTHER,
    });
  });

  it("routes to the internal endpoint when the current account is unknown", () => {
    expect(resolveCopyDestination(OTHER, null)).toEqual({
      kind: "other",
      accountId: OTHER,
    });
  });
});

describe("formatCopySuccess", () => {
  it("names the flow and node count without implementation details", () => {
    const s = formatCopySuccess({ flowName: "X - Copy", nodeCount: 5, warnings: [] });
    expect(s.title).toBe('"X - Copy" copied (5 nodes).');
    expect(s.description).toBeUndefined();
  });

  it("summarizes warnings generically", () => {
    const s = formatCopySuccess({
      flowName: "X - Copy",
      nodeCount: 2,
      warnings: [
        { node_key: "a", field: "tag_id", reason: "raw technical reason" },
        { node_key: "b", field: "webhook.secret", reason: "raw" },
      ],
    });
    expect(s.description).toContain("2 items need attention");
    expect(s.description).not.toContain("raw technical reason");
    expect(s.description).not.toContain("raw");
  });
});

describe("formatCopyWarning", () => {
  it("maps known fields to plain language", () => {
    expect(
      formatCopyWarning({ node_key: "a", field: "tag_id", reason: "x" }),
    ).toContain("pick a tag");
    expect(
      formatCopyWarning({ node_key: "a", field: "subject_key", reason: "x" }),
    ).toContain("pick a tag");
    expect(
      formatCopyWarning({ node_key: "a", field: "assign_to", reason: "x" }),
    ).toContain("pick who handles handoffs");
    expect(
      formatCopyWarning({ node_key: "a", field: "webhook.secret", reason: "x" }),
    ).toContain("re-enter its secret");
    expect(
      formatCopyWarning({ node_key: "a", field: "media_url", reason: "x" }),
    ).toContain("re-upload it");
    expect(
      formatCopyWarning({ node_key: "a", field: "sheet_link", reason: "x" }),
    ).toContain("link it again");
  });

  it("degrades unknown fields to a safe generic line", () => {
    const out = formatCopyWarning({
      node_key: "a",
      field: "something_new",
      reason: "source account credential leaked",
    });
    expect(out).toContain("review it");
    expect(out).not.toContain("credential");
  });
});

describe("formatCopyError", () => {
  it("uses a generic permission line for 403 (no auth details)", () => {
    expect(formatCopyError(403, "Not authorized to copy this flow.")).toBe(
      "You don't have permission to copy this flow.",
    );
  });

  it("names neither side on 404", () => {
    expect(formatCopyError(404, "Target account not found.")).toBe(
      "The flow or account could not be found.",
    );
  });

  it("passes server messages through otherwise, with a fallback", () => {
    expect(formatCopyError(500, "Copy failed.")).toBe("Copy failed.");
    expect(formatCopyError(500, "")).toBe("Couldn't copy flow.");
  });

  it("passes 401 messages through for normal session handling", () => {
    expect(formatCopyError(401, "Unauthorized")).toBe("Unauthorized");
  });
});

describe("copy dialog UI wording", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "copy-flow-dialog.tsx"), "utf8");

  it("never describes cross-account mechanics", () => {
    const forbidden = [
      "cross-account",
      "cross account",
      "Cross-account",
      "Cross Account",
      "transfer",
      "Transfer",
      "internal copy",
      "Internal Copy",
      "Copy to another account",
      "Source Account",
      "Target Account",
      "source account",
      "target account",
    ];
    for (const phrase of forbidden) {
      expect(
        source.includes(phrase),
        `UI source must not contain ${JSON.stringify(phrase)}`,
      ).toBe(false);
    }
  });

  it("uses only the allowed labels", () => {
    for (const label of ["Copy Flow", "Account", "Cancel"]) {
      expect(source.includes(label)).toBe(true);
    }
  });
});
