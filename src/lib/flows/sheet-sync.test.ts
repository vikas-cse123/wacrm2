// ============================================================
// resolveFlowSheetColumns ordering tests.
//
// New sheets persist answer columns in canonical flow (graph-walk)
// order even when the node rows arrive shuffled; existing sheets keep
// their stored order with genuinely new keys appended (never moved).
// ============================================================

import { describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveFlowSheetColumns,
  type FlowSheetConfigRow,
} from "./sheet-sync";

function sheet(
  overrides: Partial<FlowSheetConfigRow> = {},
): FlowSheetConfigRow {
  return {
    flow_id: "flow-1",
    account_id: "acct-1",
    spreadsheet_id: "ss-1",
    spreadsheet_url: null,
    spreadsheet_name: null,
    sheet_tab: "Sheet1",
    answer_columns: [],
    answer_headers: [],
    header_written: false,
    schema_version: 3,
    name_column_key: null,
    name_column_header: null,
    ...overrides,
  };
}

function collectNode(
  node_key: string,
  var_key: string,
  next?: string,
  header?: string,
) {
  return {
    node_key,
    node_type: "collect_input",
    config: {
      var_key,
      prompt_text: `${var_key}?`,
      ...(next ? { next_node_key: next } : {}),
      ...(header ? { sheet_column_name: header } : {}),
    },
    created_at: "2026-07-14T10:00:00.000Z",
  };
}

function makeDb(
  sheetRow: FlowSheetConfigRow,
  nodes: Record<string, unknown>[],
  entry: string | null,
) {
  const updates: Array<{ table: string; payload: unknown }> = [];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.order = vi.fn(() => b);
    b.update = vi.fn((payload: unknown) => {
      updates.push({ table, payload });
      return b;
    });
    b.maybeSingle = vi.fn(async () => {
      if (table === "flow_sheet_configs") {
        return { data: sheetRow, error: null };
      }
      return { data: { entry_node_id: entry }, error: null };
    });
    b.single = vi.fn(async () => ({ data: sheetRow, error: null }));
    (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      if (table === "flow_nodes") {
        return resolve({ data: nodes, error: null });
      }
      return resolve({ data: null, error: null });
    };
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, updates };
}

// Shuffled storage order on purpose: graph is start→month→rooms→hotel.
const SHUFFLED_NODES = [
  collectNode("hotel", "hotel"),
  { node_key: "start", node_type: "start", config: { next_node_key: "month" } },
  collectNode("rooms", "rooms", "hotel", "Rooms"),
  collectNode("month", "month", "rooms", "Month"),
];

describe("resolveFlowSheetColumns ordering", () => {
  it("persists new-sheet columns in flow order despite shuffled rows", async () => {
    const { db, updates } = makeDb(sheet(), SHUFFLED_NODES, "start");
    const resolved = await resolveFlowSheetColumns(db, "flow-1", null);
    expect(resolved?.keys).toEqual(["month", "rooms", "hotel"]);
    expect(resolved?.headers).toEqual(["Month", "Rooms", "hotel?"]);
    const persisted = updates.find((u) => u.table === "flow_sheet_configs");
    expect(
      (persisted?.payload as { answer_columns: string[] }).answer_columns,
    ).toEqual(["month", "rooms", "hotel"]);
  });

  it("keeps stored order and appends new keys without moving history", async () => {
    const { db } = makeDb(
      sheet({
        answer_columns: ["rooms", "month"],
        answer_headers: ["Rooms", "Month"],
        header_written: true,
      }),
      SHUFFLED_NODES,
      "start",
    );
    const resolved = await resolveFlowSheetColumns(db, "flow-1", null);
    // Legacy arrival order preserved; genuinely new key appended.
    expect(resolved?.keys).toEqual(["rooms", "month", "hotel"]);
    expect(resolved?.headers).toEqual(["Rooms", "Month", "hotel?"]);
  });
});
