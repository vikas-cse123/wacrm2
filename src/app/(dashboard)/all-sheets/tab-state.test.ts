// All Sheets flow-tab UI state regression tests.
//
// The production bug: after deleting a flow's tab, the flow card showed
// both "Add to All Sheets" AND "Open Sheet", because the flow-level link
// was conditioned on collection existence instead of the flow's own tab
// record. These tests lock the corrected rule:
//
//   collection exists + no tab  → no flow-level Open Sheet, Add is shown.
//   collection exists + tab     → Open Sheet (deep-linked), tab actions.
//   deleting the tab            → back to Add, collection View Sheet stays.

import { describe, expect, it } from "vitest";
import { flowTabSheetHref, flowTabUiState } from "./tab-state";

const COLLECTION_URL = "https://docs.google.com/spreadsheets/d/SS1/edit";
const TAB = { id: "tab-1", worksheet_id: 123, worksheet_title: "Kashmir Honeymoon Ad Chat Flow" };

describe("flowTabUiState", () => {
  it("collection exists + no flow tab → not-added (Add to All Sheets)", () => {
    // The collection URL existing alongside a null tab must not matter:
    // source of truth is the tab record alone.
    expect(flowTabUiState(null)).toBe("not-added");
    expect(flowTabUiState(undefined)).toBe("not-added");
  });

  it("collection exists + flow tab exists → added", () => {
    expect(flowTabUiState(TAB)).toBe("added");
  });

  it("deleting the tab returns state to not-added", () => {
    expect(flowTabUiState(TAB)).toBe("added");
    // After DELETE /api/all-sheets/tabs/:id the API returns tab: null.
    expect(flowTabUiState(null)).toBe("not-added");
  });
});

describe("flowTabSheetHref", () => {
  it("no tab record → no flow-level Open Sheet even with a collection URL (case 1)", () => {
    expect(flowTabSheetHref(COLLECTION_URL, null)).toBeNull();
    expect(flowTabSheetHref(COLLECTION_URL, undefined)).toBeNull();
  });

  it("tab record → Open Sheet deep-linked to the tab (case 3)", () => {
    expect(flowTabSheetHref(COLLECTION_URL, TAB)).toBe(`${COLLECTION_URL}#gid=123`);
  });

  it("tab without a known worksheet id falls back to the shared URL", () => {
    expect(flowTabSheetHref(COLLECTION_URL, { ...TAB, worksheet_id: null })).toBe(COLLECTION_URL);
  });

  it("missing collection URL → no link even with a tab", () => {
    expect(flowTabSheetHref(null, TAB)).toBeNull();
  });

  it("strips a pre-existing fragment before appending the tab gid", () => {
    expect(flowTabSheetHref(`${COLLECTION_URL}#gid=999`, TAB)).toBe(`${COLLECTION_URL}#gid=123`);
  });
});

describe("completed vs incomplete independence (case 7)", () => {
  it("each kind derives state from its own tab record only", () => {
    const completedTab = { ...TAB, id: "tab-c" };
    // Completed added, incomplete not added: states must differ.
    expect(flowTabUiState(completedTab)).toBe("added");
    expect(flowTabUiState(null)).toBe("not-added");
    // Links are per-tab: gid values never cross kinds.
    const completedHref = flowTabSheetHref("https://docs.google.com/spreadsheets/d/SS-COMPLETED/edit", completedTab);
    const incompleteHref = flowTabSheetHref("https://docs.google.com/spreadsheets/d/SS-INCOMPLETE/edit", null);
    expect(completedHref).toContain("SS-COMPLETED");
    expect(incompleteHref).toBeNull();
  });
});
