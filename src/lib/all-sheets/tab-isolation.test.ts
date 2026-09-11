// All Sheets behavioral isolation tests (collection/tab model).
//
// These tests execute the real All Sheets orchestration
// (getOrCreateCollection, ensureFlowTab, importAllSheetCompleted,
// refreshAllSheetIncomplete, deleteFlowTab) against:
//   - an in-memory fake Supabase client that records every table touched,
//   - a stubbed global.fetch that emulates the Google Sheets REST API.
//
// They prove, behaviorally (not just statically):
//   3. Two completed flows share ONE spreadsheet_id, DIFFERENT worksheet_ids.
//   4. Incomplete collection uses a DIFFERENT spreadsheet_id than completed.
//   5. Creating a second flow never creates a second completed spreadsheet.
//   6. Deleting one flow removes only its tab; collection + siblings intact.
//   7. Importing Flow A appends only to Flow A's tab range.
//   8. All Sheets never touches flow_sheet_configs.
//   9. All Sheets never touches flow_incomplete_sheet_configs, and never
//      reads/writes flow_runs.incomplete_synced_at.
// Plus: tab creation writes the header only (no run import), and
// re-ensuring a tab reuses it instead of duplicating.
//
// No network, no database, no Google account required.

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteFlowTab,
  importAllSheetCompleted,
  refreshAllSheetIncomplete,
} from "@/lib/all-sheets/sync";
import { handleAllSheetCompletion } from "@/lib/all-sheets/completion";
import { runAllSheetsCron } from "@/lib/all-sheets/auto-sync";
import { quoteSheetTitle } from "@/lib/google/tabs";
import type {
  AllSheetCollectionRow,
  AllSheetFlowTabRow,
} from "@/lib/all-sheets/types";

// ------------------------------------------------------------
// In-memory fake Supabase client (records every table touched)
// ------------------------------------------------------------
type Row = Record<string, unknown>;

interface QueryLog {
  table: string;
  op: string;
  detail?: unknown;
}

interface QueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

class FakeBuilder implements PromiseLike<QueryResult> {
  private mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private filters: Array<(r: Row) => boolean> = [];
  private payload: unknown = null;
  private upsertConflict: string[] = [];
  private upsertIgnoreDuplicates = false;
  private wantData = false;
  private wantSingle = false;
  private wantMaybeSingle = false;
  private orderings: Array<{ col: string; ascending: boolean }> = [];
  private rangeVal: [number, number] | null = null;
  private limitVal: number | null = null;
  private selectCols: string | null = null;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(cols?: string): this {
    this.wantData = true;
    if (cols !== undefined) {
      this.selectCols = cols;
      this.db.log.push({ table: this.table, op: "select", detail: cols });
    }
    return this;
  }
  eq(col: string, val: unknown): this {
    this.db.log.push({ table: this.table, op: "eq", detail: `${col}=${String(val)}` });
    this.filters.push((r) => r[col] === val);
    return this;
  }
  neq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] !== val);
    return this;
  }
  is(col: string, val: unknown): this {
    this.db.log.push({ table: this.table, op: "is", detail: `${col}` });
    this.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.filters.push((r) => (vals as unknown[]).includes(r[col]));
    return this;
  }
  gte(col: string, val: unknown): this {
    this.filters.push((r) => (r[col] as string) >= (val as string));
    return this;
  }
  lt(col: string, val: unknown): this {
    this.filters.push((r) => (r[col] as string) < (val as string));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderings.push({ col, ascending: opts?.ascending ?? true });
    return this;
  }
  range(from: number, to: number): this {
    this.rangeVal = [from, to];
    return this;
  }
  limit(n: number): this {
    this.limitVal = n;
    return this;
  }
  insert(payload: unknown): this {
    this.mode = "insert";
    this.payload = payload;
    this.db.log.push({ table: this.table, op: "insert" });
    return this;
  }
  update(patch: unknown): this {
    this.mode = "update";
    this.payload = patch;
    this.db.log.push({ table: this.table, op: "update", detail: Object.keys((patch as Row) ?? {}) });
    return this;
  }
  upsert(payload: unknown, opts?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.mode = "upsert";
    this.payload = payload;
    this.upsertConflict = (opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    this.upsertIgnoreDuplicates = opts?.ignoreDuplicates ?? false;
    this.db.log.push({ table: this.table, op: "upsert" });
    return this;
  }
  delete(): this {
    this.mode = "delete";
    this.db.log.push({ table: this.table, op: "delete" });
    return this;
  }
  single(): Promise<QueryResult> {
    this.wantSingle = true;
    return Promise.resolve(this.exec());
  }
  maybeSingle(): Promise<QueryResult> {
    this.wantMaybeSingle = true;
    return Promise.resolve(this.exec());
  }
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((v: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((e: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.exec()).then(onfulfilled, onrejected);
  }

  private rows(): Row[] {
    return this.db.tables[this.table] ?? [];
  }

  private exec(): QueryResult {
    const store = this.db.tables[this.table] ?? (this.db.tables[this.table] = []);
    if (this.mode === "insert") {
      const arr = Array.isArray(this.payload) ? (this.payload as Row[]) : [this.payload as Row];
      for (const row of arr) {
        if (row["id"] == null) row["id"] = this.db.nextId();
        store.push({ ...row });
      }
      const data = this.wantData ? arr : null;
      if (this.wantSingle) {
        return arr[0] ? { data: arr[0], error: null } : { data: null, error: { message: "No rows" } };
      }
      return { data, error: null };
    }
    if (this.mode === "upsert") {
      const arr = Array.isArray(this.payload) ? (this.payload as Row[]) : [this.payload as Row];
      for (const row of arr) {
        const idx = store.findIndex((r) => this.upsertConflict.every((c) => r[c] === row[c]));
        if (idx >= 0) {
          if (!this.upsertIgnoreDuplicates) store[idx] = { ...store[idx], ...row };
        } else {
          if (row["id"] == null) row["id"] = this.db.nextId();
          store.push({ ...row });
        }
      }
      return { data: null, error: null };
    }
    const matched = store.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") {
      for (const r of matched) Object.assign(r, this.payload as Row);
      const data = this.wantData ? matched : null;
      if (this.wantSingle) {
        return matched[0]
          ? { data: matched[0], error: null }
          : { data: null, error: { message: "No rows", code: "PGRST116" } };
      }
      return { data, error: null };
    }
    if (this.mode === "delete") {
      this.db.tables[this.table] = store.filter((r) => !this.filters.every((f) => f(r)));
      return { data: null, error: null };
    }
    let out = [...matched];
    for (const o of this.orderings) {
      out.sort((a, b) => {
        const av = String(a[o.col] ?? "");
        const bv = String(b[o.col] ?? "");
        return o.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.rangeVal) out = out.slice(this.rangeVal[0], this.rangeVal[1] + 1);
    if (this.limitVal != null) out = out.slice(0, this.limitVal);
    if (this.wantSingle) {
      return out[0]
        ? { data: out[0], error: null }
        : { data: null, error: { message: "No rows", code: "PGRST116" } };
    }
    if (this.wantMaybeSingle) return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }
}

class FakeDb {
  tables: Record<string, Row[]> = {};
  log: QueryLog[] = [];
  private idSeq = 1;
  /** Mimics `DEFAULT gen_random_uuid()` for rows inserted without an id. */
  nextId(): string {
    return `fake-id-${this.idSeq++}`;
  }
  from(table: string): FakeBuilder {
    this.log.push({ table, op: "from" });
    return new FakeBuilder(this, table);
  }
  touchedTables(): Set<string> {
    return new Set(this.log.map((l) => l.table));
  }
  loggedText(): string {
    return JSON.stringify(this.log);
  }
}

// ------------------------------------------------------------
// Google Sheets REST stub
// ------------------------------------------------------------
interface MockTab {
  sheetId: number;
  title: string;
}
interface MockSpreadsheet {
  title: string;
  tabs: MockTab[];
}

class MockGoogle {
  spreadsheets: Record<string, MockSpreadsheet> = {};
  nextSpreadsheet = 1;
  nextSheetId = 100;
  createSpreadsheetCalls = 0;
  appendCalls: Array<{ url: string; rows: unknown }> = [];
  valueBatchBodies: unknown[] = [];
  deletedSheetIds: number[] = [];
  deletedSpreadsheetIds: string[] = [];
  rowDeleteCalls: Array<{ ssid: string; request: unknown }> = [];
  failNextAppend = false;

  async fetch(input: unknown, init?: { method?: string; body?: string }): Promise<unknown> {
    const url = String(input);
    const method = init?.method ?? "GET";

    // Google Drive file delete (collection teardown on final-tab delete).
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/") && method === "DELETE") {
      const ssid = decodeURIComponent(url.split("/").pop() ?? "");
      this.deletedSpreadsheetIds.push(ssid);
      delete this.spreadsheets[ssid];
      return this.ok({});
    }

    const base = "https://sheets.googleapis.com/v4/spreadsheets";

    if (url === base && method === "POST") {
      const body = JSON.parse(init?.body ?? "{}") as { properties?: { title?: string } };
      const id = `SS${this.nextSpreadsheet++}`;
      this.createSpreadsheetCalls++;
      this.spreadsheets[id] = { title: body.properties?.title ?? id, tabs: [{ sheetId: 0, title: "Sheet1" }] };
      return this.ok({
        spreadsheetId: id,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}`,
        properties: { title: this.spreadsheets[id]?.title },
        sheets: [{ properties: { title: "Sheet1" } }],
      });
    }

    const m = url.match(/\/spreadsheets\/([^/:?]+)(.*)$/);
    if (!m) throw new Error(`MockGoogle: unexpected URL ${url}`);
    const ssid = m[1] ?? "";
    const rest = m[2] ?? "";
    const ss = this.spreadsheets[ssid];
    if (!ss) {
      const err = new Error(`MockGoogle: unknown spreadsheet ${ssid} (404)`) as Error & { status?: number };
      err.status = 404;
      throw err;
    }

    if (rest.startsWith("?fields=")) {
      return this.ok({ sheets: ss.tabs.map((t, i) => ({ properties: { sheetId: t.sheetId, title: t.title, index: i } })) });
    }
    if (rest === ":batchUpdate" && method === "POST") {
      const body = JSON.parse(init?.body ?? "{}") as { requests?: Array<Record<string, unknown>> };
      const replies: unknown[] = [];
      for (const req of body.requests ?? []) {
        if (req["addSheet"]) {
          const title = ((req["addSheet"] as Record<string, unknown>)["properties"] as Record<string, unknown>)?.["title"] as string;
          const sheetId = this.nextSheetId++;
          ss.tabs.push({ sheetId, title });
          replies.push({ addSheet: { properties: { sheetId } } });
        } else if (req["deleteSheet"]) {
          const sheetId = (req["deleteSheet"] as Record<string, unknown>)["sheetId"] as number;
          this.deletedSheetIds.push(sheetId);
          ss.tabs = ss.tabs.filter((t) => t.sheetId !== sheetId);
          replies.push({});
        } else if (req["updateSheetProperties"]) {
          const props = (req["updateSheetProperties"] as Record<string, unknown>)["properties"] as Record<string, unknown>;
          const tab = ss.tabs.find((t) => t.sheetId === (props["sheetId"] as number));
          if (tab) tab.title = props["title"] as string;
          replies.push({});
        } else if (req["deleteDimension"]) {
          this.rowDeleteCalls.push({ ssid, request: req["deleteDimension"] });
          replies.push({});
        } else {
          replies.push({});
        }
      }
      return this.ok({ replies });
    }
    if (rest.includes("/values/") && rest.includes(":append")) {
      if (this.failNextAppend) {
        this.failNextAppend = false;
        return {
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve("injected Google failure"),
        };
      }
      const body = JSON.parse(init?.body ?? "{}") as { values?: unknown };
      this.appendCalls.push({ url, rows: body.values });
      return this.ok({});
    }
    if (rest === "/values:batchUpdate") {
      this.valueBatchBodies.push(JSON.parse(init?.body ?? "{}"));
      return this.ok({});
    }
    if (rest.includes("/values/")) {
      // Header read (`!1:1`) returns a header containing the hidden Run ID
      // column; column reads return the ids the test seeded.
      if (rest.includes("!1%3A1") || rest.includes("!1:1")) {
        return this.ok({ values: [["Phone Number", "Submission Time", "Flow Run ID"]] });
      }
      return this.ok({ values: [this.columnHits] });
    }
    throw new Error(`MockGoogle: unhandled ${method} ${url}`);
  }

  columnHits: string[] = [];

  private ok(payload: unknown): { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> } {
    return { ok: true, status: 200, json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)) };
  }
}

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------
const ACC = "acc-1";
const FA = "flow-a";
const FB = "flow-b";
const C1 = "contact-1";

function seedBase(db: FakeDb): void {
  db.tables["flows"] = [
    { id: FA, account_id: ACC, name: "Kashmir Winter + New Year Ad Chat Flow", entry_node_id: "start" },
    { id: FB, account_id: ACC, name: "Honeymoon", entry_node_id: "start" },
  ];
  const nodesA = [
    { node_key: "start", node_type: "start", config: {}, created_at: "2024-01-01T00:00:00Z" },
    { node_key: "q_name", node_type: "collect_input", config: { var_key: "name", prompt_text: "Your name?" }, created_at: "2024-01-01T00:01:00Z" },
    { node_key: "q_guests", node_type: "collect_input", config: { var_key: "guests", prompt_text: "How many guests?" }, created_at: "2024-01-01T00:02:00Z" },
    { node_key: "sync", node_type: "google_sheets_sync", config: { next_node_key: "end" }, created_at: "2024-01-01T00:03:00Z" },
    { node_key: "end", node_type: "end", config: {}, created_at: "2024-01-01T00:04:00Z" },
  ];
  const nodesB = [
    { node_key: "start", node_type: "start", config: {}, created_at: "2024-01-01T00:00:00Z" },
    { node_key: "q_name", node_type: "collect_input", config: { var_key: "name", prompt_text: "Your name?" }, created_at: "2024-01-01T00:01:00Z" },
    { node_key: "end", node_type: "end", config: {}, created_at: "2024-01-01T00:02:00Z" },
  ];
  db.tables["flow_nodes"] = [
    ...nodesA.map((n) => ({ ...n, flow_id: FA })),
    ...nodesB.map((n) => ({ ...n, flow_id: FB })),
  ];
  db.tables["contacts"] = [{ id: C1, phone: "+911", name: "Asha" }];
  db.tables["flow_runs"] = [
    { id: "R1", flow_id: FA, account_id: ACC, contact_id: C1, status: "completed", vars: { name: "Asha", guests: "2" }, started_at: "2024-02-01T00:00:00Z", ended_at: "2024-02-01T00:05:00Z" },
    { id: "R2", flow_id: FA, account_id: ACC, contact_id: C1, status: "completed", vars: { name: "Ravi" }, started_at: "2024-02-02T00:00:00Z", ended_at: "2024-02-02T00:05:00Z" },
    { id: "R3", flow_id: FB, account_id: ACC, contact_id: C1, status: "completed", vars: { name: "B" }, started_at: "2024-02-03T00:00:00Z", ended_at: "2024-02-03T00:05:00Z" },
    { id: "R4", flow_id: FA, account_id: ACC, contact_id: C1, status: "timed_out", vars: { name: "Drop" }, started_at: "2024-02-04T00:00:00Z", ended_at: "2024-02-04T01:05:00Z" },
  ];
  db.tables["all_sheet_collections"] = [];
  db.tables["all_sheet_flow_tabs"] = [];
  db.tables["all_sheet_tab_run_state"] = [];
  db.tables["all_sheet_tab_sync_failures"] = [];
}

function setupEnv(): { db: FakeDb; google: MockGoogle } {
  const db = new FakeDb();
  seedBase(db);
  const google = new MockGoogle();
  vi.stubGlobal("fetch", (input: unknown, init?: { method?: string; body?: string }) => google.fetch(input, init));
  return { db, google };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function asSupabase(db: FakeDb): SupabaseClient {
  return db as unknown as SupabaseClient;
}

async function addFlow(
  db: FakeDb,
  kind: "completed" | "incomplete",
  flowId: string,
  flowName: string,
  token = "tok",
): Promise<{ collection: AllSheetCollectionRow; tab: AllSheetFlowTabRow }> {
  const { getOrCreateCollection } = await import("@/lib/all-sheets/collections");
  const { ensureFlowTab } = await import("@/lib/all-sheets/flow-tabs");
  const { collection } = await getOrCreateCollection(asSupabase(db), ACC, kind, token);  const { tab } = await ensureFlowTab(asSupabase(db), collection, kind, flowId, flowName, token);
  return { collection, tab };
}

function assertProtectedTablesUntouched(db: FakeDb): void {
  const touched = db.touchedTables();
  expect(touched.has("flow_sheet_configs")).toBe(false);
  expect(touched.has("flow_incomplete_sheet_configs")).toBe(false);
  expect(touched.has("google_sheets_sync_failures")).toBe(false);
  // flow_runs is read as source data, but its existing watermark column
  // must never appear in any logged select/update payload.
  expect(db.loggedText()).not.toContain("incomplete_synced_at");
}

// ------------------------------------------------------------
// Tests 3–7: collection/tab sharing, creation, deletion, routing
// ------------------------------------------------------------
describe("all-sheets collection/tab behavior", () => {
  it("two completed flows share ONE spreadsheet_id with DIFFERENT worksheet_ids (checks 3+5)", async () => {
    const { db, google } = setupEnv();
    const a = await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    const b = await addFlow(db, "completed", FB, "Honeymoon");

    expect(a.collection.spreadsheet_id).toBe(b.collection.spreadsheet_id);
    expect(a.tab.worksheet_id).not.toBeNull();
    expect(b.tab.worksheet_id).not.toBeNull();
    expect(a.tab.worksheet_id).not.toBe(b.tab.worksheet_id);
    // Second flow created no additional spreadsheet.
    expect(google.createSpreadsheetCalls).toBe(1);

    // Tab creation writes the header only — no run rows imported.
    expect(db.tables["all_sheet_tab_run_state"]?.length ?? 0).toBe(0);
    assertProtectedTablesUntouched(db);
  });

  it("incomplete collection uses a DIFFERENT spreadsheet_id than completed (check 4)", async () => {
    const { db } = setupEnv();
    const completed = await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    const incomplete = await addFlow(db, "incomplete", FA, "Kashmir Winter + New Year Ad Chat Flow");

    expect(incomplete.collection.spreadsheet_id).not.toBe(completed.collection.spreadsheet_id);
    assertProtectedTablesUntouched(db);
  });

  it("re-adding a flow reuses its tab instead of duplicating (check 5)", async () => {
    const { db, google } = setupEnv();
    const first = await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    const second = await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");

    expect(second.tab.id).toBe(first.tab.id);
    expect(second.tab.worksheet_id).toBe(first.tab.worksheet_id);
    expect(db.tables["all_sheet_flow_tabs"]?.length ?? 0).toBe(1);
    expect(google.createSpreadsheetCalls).toBe(1);
    assertProtectedTablesUntouched(db);
  });

  it("deleting one flow removes only its tab; collection + siblings intact (check 6)", async () => {
    const { db, google } = setupEnv();
    const a = await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    const b = await addFlow(db, "completed", FB, "Honeymoon");

    await deleteFlowTab(asSupabase(db), a.collection, a.tab, "tok");

    // Drive: exactly the deleted tab's sheetId was removed.
    expect(google.deletedSheetIds).toEqual([a.tab.worksheet_id]);
    // DB: tab row + its state gone; sibling tab and collection intact.
    expect(db.tables["all_sheet_flow_tabs"]?.map((t) => t["id"])).toEqual([b.tab.id]);
    expect(db.tables["all_sheet_collections"]?.length ?? 0).toBe(1);
    // Collection spreadsheet still has the sibling tab live in Drive.
    const ss = google.spreadsheets[a.collection.spreadsheet_id];
    expect(ss?.tabs.map((t) => t.sheetId)).toContain(b.tab.worksheet_id);
    assertProtectedTablesUntouched(db);
  });

  it("4 flows share one spreadsheet; deleting 3 keeps it + the survivor (checks 1+2)", async () => {
    const { db, google } = setupEnv();
    (db.tables["flows"] as Row[]).push(
      { id: "flow-c", account_id: ACC, name: "Katra + Kashmir", entry_node_id: "start" },
      { id: "flow-d", account_id: ACC, name: "Diwali", entry_node_id: "start" },
    );
    const a = await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    const b = await addFlow(db, "completed", FB, "Honeymoon");
    const c = await addFlow(db, "completed", "flow-c", "Katra + Kashmir");
    const d = await addFlow(db, "completed", "flow-d", "Diwali");

    const ssids = new Set([a, b, c, d].map((x) => x.collection.spreadsheet_id));
    expect(ssids.size).toBe(1);
    expect(new Set([a, b, c, d].map((x) => x.tab.worksheet_id)).size).toBe(4);
    expect(google.createSpreadsheetCalls).toBe(1);
    // No placeholder Sheet1 left behind: first add renamed it, rest added tabs.
    const ss = google.spreadsheets[a.collection.spreadsheet_id];
    expect(ss?.tabs.map((t) => t.title)).not.toContain("Sheet1");

    for (const x of [a, b, c]) {
      await deleteFlowTab(asSupabase(db), x.collection, x.tab, "tok");
    }
    // Survivor keeps the spreadsheet; deleted tabs are gone from Drive.
    expect(db.tables["all_sheet_collections"]?.length ?? 0).toBe(1);
    expect(db.tables["all_sheet_flow_tabs"]?.map((t) => t["id"])).toEqual([d.tab.id]);
    expect(google.deletedSpreadsheetIds).toHaveLength(0);
    const survivorTabs = google.spreadsheets[d.collection.spreadsheet_id]?.tabs.map((t) => t.sheetId) ?? [];
    expect(survivorTabs).toContain(d.tab.worksheet_id);
    assertProtectedTablesUntouched(db);
  });

  it("deleting the final flow deletes spreadsheet + collection + tabs (checks 3+4+5)", async () => {
    const { db, google } = setupEnv();
    const { collection, tab } = await addFlow(db, "completed", FA, "Kashmir Honeymoon Ad Chat Flow");

    const result = await deleteFlowTab(asSupabase(db), collection, tab, "tok");

    expect(result.spreadsheetDeleted).toBe(true);
    expect(google.deletedSpreadsheetIds).toEqual([collection.spreadsheet_id]);
    expect(google.spreadsheets[collection.spreadsheet_id]).toBeUndefined();
    expect(db.tables["all_sheet_flow_tabs"]?.length ?? 0).toBe(0);
    expect(db.tables["all_sheet_tab_run_state"]?.length ?? 0).toBe(0);
    expect(db.tables["all_sheet_collections"]?.length ?? 0).toBe(0);
    assertProtectedTablesUntouched(db);
  });

  it("re-add after complete deletion creates a NEW spreadsheet; next add reuses it (checks 6+7)", async () => {
    const { db, google } = setupEnv();
    const first = await addFlow(db, "completed", FA, "Kashmir Honeymoon Ad Chat Flow");
    const oldSsid = first.collection.spreadsheet_id;
    await deleteFlowTab(asSupabase(db), first.collection, first.tab, "tok");

    const again = await addFlow(db, "completed", FA, "Kashmir Honeymoon Ad Chat Flow");
    expect(again.collection.spreadsheet_id).not.toBe(oldSsid);
    expect(google.createSpreadsheetCalls).toBe(2);

    const sibling = await addFlow(db, "completed", FB, "Honeymoon");
    expect(sibling.collection.spreadsheet_id).toBe(again.collection.spreadsheet_id);
    // Never a third spreadsheet just because another flow was added.
    expect(google.createSpreadsheetCalls).toBe(2);
    assertProtectedTablesUntouched(db);
  });

  it("final delete of completed leaves the incomplete collection alone (check 8)", async () => {
    const { db, google } = setupEnv();
    const completed = await addFlow(db, "completed", FA, "Kashmir Honeymoon Ad Chat Flow");
    const incomplete = await addFlow(db, "incomplete", FA, "Kashmir Honeymoon Ad Chat Flow");

    await deleteFlowTab(asSupabase(db), completed.collection, completed.tab, "tok");

    expect(google.deletedSpreadsheetIds).toEqual([completed.collection.spreadsheet_id]);
    expect(db.tables["all_sheet_collections"]?.map((c) => c["id"])).toEqual([incomplete.collection.id]);
    expect(db.tables["all_sheet_flow_tabs"]?.map((t) => t["id"])).toEqual([incomplete.tab.id]);
    assertProtectedTablesUntouched(db);
  });

  it("a Drive-deleted collection spreadsheet is healed on next add", async () => {
    const { db, google } = setupEnv();
    const first = await addFlow(db, "completed", FA, "Kashmir Honeymoon Ad Chat Flow");
    // Spreadsheet deleted out-of-band in Drive; DB row is now stale.
    delete google.spreadsheets[first.collection.spreadsheet_id];

    const healed = await addFlow(db, "completed", FB, "Honeymoon");
    expect(healed.collection.spreadsheet_id).not.toBe(first.collection.spreadsheet_id);
    expect(healed.collection.id).not.toBe(first.collection.id);
    expect(db.tables["all_sheet_collections"]?.length ?? 0).toBe(1);
    assertProtectedTablesUntouched(db);
  });
});

// ------------------------------------------------------------
// Automatic lifecycle: timeout sweep, completion transition,
// worker idempotency + retry, multi-flow/account isolation.
// ------------------------------------------------------------
function completedAppendsTo(google: MockGoogle, ssid: string): string[] {
  return google.appendCalls.map((c) => c.url).filter((u) => u.includes(`/spreadsheets/${ssid}/values/`));
}

describe("all-sheets automatic lifecycle", () => {
  it("1. run completes before threshold → Completed only, never Incomplete", async () => {
    const { db, google } = setupEnv();
    const completed = await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    await addFlow(db, "incomplete", FA, "Kashmir Winter + New Year Ad Chat Flow");
    (db.tables["flow_runs"] as Row[]).push({
      id: "R5", flow_id: FA, account_id: ACC, contact_id: C1, status: "completed",
      vars: { name: "Early" }, started_at: "2024-03-01T09:00:00Z", ended_at: "2024-03-01T09:05:00Z",
    });
    google.appendCalls = [];

    const res = await handleAllSheetCompletion(asSupabase(db), "R5", { getToken: async () => "tok" });
    expect(res.completed).toBe(true);

    const incompleteTab = (db.tables["all_sheet_flow_tabs"] as Row[]).find(
      (t) => t["flow_id"] === FA && t["collection_id"] !== completed.collection.id,
    );
    const incStates = ((db.tables["all_sheet_tab_run_state"] as Row[]) ?? []).filter(
      (s) => s["tab_id"] === incompleteTab?.["id"],
    );
    expect(incStates).toHaveLength(0);
    expect(completedAppendsTo(google, completed.collection.spreadsheet_id)).toHaveLength(1);
    assertProtectedTablesUntouched(db);
  });

  it("2. run reaching the threshold is swept to timed_out and lands in Incomplete only", async () => {
    const { db, google } = setupEnv();
    const inc = await addFlow(db, "incomplete", FA, "Kashmir Winter + New Year Ad Chat Flow");
    const comp = await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    (db.tables["flow_runs"] as Row[]).push({
      id: "R6", flow_id: FA, account_id: ACC, contact_id: C1, status: "active",
      vars: { name: "Slow" }, started_at: "2024-01-01T09:00:00Z", ended_at: null,
      last_advanced_at: "2024-01-01T09:00:00Z",
    });
    google.appendCalls = [];

    const res = await runAllSheetsCron({ db: asSupabase(db), getToken: async () => "tok" });
    expect(res.swept).toBe(1);

    const r6 = (db.tables["flow_runs"] as Row[]).find((r) => r["id"] === "R6");
    expect(r6?.["status"]).toBe("timed_out");
    const incStates = ((db.tables["all_sheet_tab_run_state"] as Row[]) ?? []).filter(
      (s) => s["tab_id"] === inc.tab.id,
    );
    expect(incStates.map((s) => s["flow_run_id"])).toContain("R6");
    // R6 never touched the completed side.
    const compStates = ((db.tables["all_sheet_tab_run_state"] as Row[]) ?? []).filter(
      (s) => s["tab_id"] === comp.tab.id,
    );
    expect(compStates.map((s) => s["flow_run_id"])).not.toContain("R6");
    assertProtectedTablesUntouched(db);
  });

  it("3. incomplete run that later completes is removed then added", async () => {
    const { db, google } = setupEnv();
    const inc = await addFlow(db, "incomplete", FA, "Kashmir Winter + New Year Ad Chat Flow");
    await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    // Simulate a prior incomplete sync of R4.
    (db.tables["all_sheet_tab_run_state"] as Row[]).push({ tab_id: inc.tab.id, flow_run_id: "R4" });
    google.columnHits = ["R4"];
    const r4 = (db.tables["flow_runs"] as Row[]).find((r) => r["id"] === "R4");
    if (r4) r4["status"] = "completed";
    google.appendCalls = [];
    google.rowDeleteCalls = [];

    const res = await handleAllSheetCompletion(asSupabase(db), "R4", { getToken: async () => "tok" });
    expect(res.completed).toBe(true);
    expect(res.removedIncomplete).toBe(true);

    expect(google.rowDeleteCalls.length).toBeGreaterThan(0);
    const incStates = ((db.tables["all_sheet_tab_run_state"] as Row[]) ?? []).filter(
      (s) => s["tab_id"] === inc.tab.id,
    );
    expect(incStates).toHaveLength(0);
    const compTab = (db.tables["all_sheet_flow_tabs"] as Row[]).find(
      (t) => t["flow_id"] === FA && t["id"] !== inc.tab.id,
    );
    const compStates = ((db.tables["all_sheet_tab_run_state"] as Row[]) ?? []).filter(
      (s) => s["tab_id"] === compTab?.["id"],
    );
    expect(compStates.map((s) => s["flow_run_id"])).toContain("R4");
    assertProtectedTablesUntouched(db);
  });

  it("4. completion before the worker never inserts into Incomplete", async () => {
    const { db, google } = setupEnv();
    await addFlow(db, "incomplete", FA, "Kashmir Winter + New Year Ad Chat Flow");
    await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    (db.tables["flow_runs"] as Row[]).push({
      id: "R5", flow_id: FA, account_id: ACC, contact_id: C1, status: "completed",
      vars: { name: "Early" }, started_at: "2024-03-01T09:00:00Z", ended_at: "2024-03-01T09:05:00Z",
    });

    await handleAllSheetCompletion(asSupabase(db), "R5", { getToken: async () => "tok" });
    google.appendCalls = [];
    await runAllSheetsCron({ db: asSupabase(db), getToken: async () => "tok" });

    // R5 (completed) is unknown to every incomplete tab.
    const allStates = ((db.tables["all_sheet_tab_run_state"] as Row[]) ?? []).filter(
      (s) => (s["flow_run_id"] as string) === "R5",
    );
    const incompleteTabIds = new Set(
      ((db.tables["all_sheet_flow_tabs"] as Row[]) ?? [])
        .filter((t) => {
          const col = ((db.tables["all_sheet_collections"] as Row[]) ?? []).find((c) => c["id"] === t["collection_id"]);
          return col?.["kind"] === "incomplete";
        })
        .map((t) => t["id"]),
    );
    const r5IncStates = allStates.filter((s) => incompleteTabIds.has(s["tab_id"] as string));
    expect(r5IncStates).toHaveLength(0);
    assertProtectedTablesUntouched(db);
  });

  it("5. worker running twice creates no duplicate Incomplete rows", async () => {
    const { db, google } = setupEnv();
    await addFlow(db, "incomplete", FA, "Kashmir Winter + New Year Ad Chat Flow");
    await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");

    const first = await runAllSheetsCron({ db: asSupabase(db), getToken: async () => "tok" });
    const appendsAfterFirst = google.appendCalls.length;
    const second = await runAllSheetsCron({ db: asSupabase(db), getToken: async () => "tok" });

    expect(first.incompleteSynced).toBeGreaterThan(0);
    expect(second.incompleteSynced).toBe(0);
    expect(google.appendCalls.length).toBe(appendsAfterFirst);
    assertProtectedTablesUntouched(db);
  });

  it("6. completion handler running twice creates no duplicate Completed rows", async () => {
    const { db, google } = setupEnv();
    await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    (db.tables["flow_runs"] as Row[]).push({
      id: "R5", flow_id: FA, account_id: ACC, contact_id: C1, status: "completed",
      vars: { name: "Dup" }, started_at: "2024-03-01T09:00:00Z", ended_at: "2024-03-01T09:05:00Z",
    });

    await handleAllSheetCompletion(asSupabase(db), "R5", { getToken: async () => "tok" });
    const afterFirst = google.appendCalls.length;
    const res = await handleAllSheetCompletion(asSupabase(db), "R5", { getToken: async () => "tok" });

    expect(res.completed).toBe(true);
    expect(google.appendCalls.length).toBe(afterFirst);
    assertProtectedTablesUntouched(db);
  });

  it("7. missing incomplete row does not block the completed append", async () => {
    const { db } = setupEnv();
    await addFlow(db, "incomplete", FA, "Kashmir Winter + New Year Ad Chat Flow");
    await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    (db.tables["flow_runs"] as Row[]).push({
      id: "R5", flow_id: FA, account_id: ACC, contact_id: C1, status: "completed",
      vars: { name: "Ghost" }, started_at: "2024-03-01T09:00:00Z", ended_at: "2024-03-01T09:05:00Z",
    });
    // columnHits stays []: the incomplete row does not exist in Drive.

    const res = await handleAllSheetCompletion(asSupabase(db), "R5", { getToken: async () => "tok" });
    expect(res.completed).toBe(true);
    assertProtectedTablesUntouched(db);
  });

  it("8. Google failure during incomplete sync retries without duplicates", async () => {
    const { db, google } = setupEnv();
    await addFlow(db, "incomplete", FA, "Kashmir Winter + New Year Ad Chat Flow");

    google.failNextAppend = true;
    await expect(
      refreshAllSheetIncomplete(
        asSupabase(db),
        ((db.tables["all_sheet_collections"] as Row[]).find(
          (c) => c["kind"] === "incomplete",
        ) as unknown as { id: string; account_id: string; kind: "completed" | "incomplete"; spreadsheet_id: string; spreadsheet_url: string | null; spreadsheet_name: string | null }),
        ((db.tables["all_sheet_flow_tabs"] as Row[])[0] as unknown as Parameters<typeof refreshAllSheetIncomplete>[2]),
        "tok",
      ),
    ).rejects.toThrow();
    expect(((db.tables["all_sheet_tab_sync_failures"] as Row[]) ?? []).length).toBeGreaterThan(0);
    expect(((db.tables["all_sheet_tab_run_state"] as Row[]) ?? []).length).toBe(0);

    const okAppendsBefore = google.appendCalls.length;
    const retry = await refreshAllSheetIncomplete(
      asSupabase(db),
      ((db.tables["all_sheet_collections"] as Row[]).find(
        (c) => c["kind"] === "incomplete",
      ) as unknown as Parameters<typeof refreshAllSheetIncomplete>[1]),
      ((db.tables["all_sheet_flow_tabs"] as Row[])[0] as unknown as Parameters<typeof refreshAllSheetIncomplete>[2]),
      "tok",
    );
    expect(retry.imported).toBe(1); // R4 only
    expect(google.appendCalls.length).toBe(okAppendsBefore + 1);
    assertProtectedTablesUntouched(db);
  });

  it("9. Google failure during completion transition retries; handler never rejects", async () => {
    const { db, google } = setupEnv();
    await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    (db.tables["flow_runs"] as Row[]).push({
      id: "R5", flow_id: FA, account_id: ACC, contact_id: C1, status: "completed",
      vars: { name: "Flaky" }, started_at: "2024-03-01T09:00:00Z", ended_at: "2024-03-01T09:05:00Z",
    });

    google.failNextAppend = true;
    const first = await handleAllSheetCompletion(asSupabase(db), "R5", { getToken: async () => "tok" });
    expect(first.completed).toBe(false); // resolved, not rejected; failure logged

    const okAppendsBefore = google.appendCalls.length;
    const second = await handleAllSheetCompletion(asSupabase(db), "R5", { getToken: async () => "tok" });
    expect(second.completed).toBe(true);
    expect(google.appendCalls.length).toBe(okAppendsBefore + 1);
    assertProtectedTablesUntouched(db);
  });

  it("10+11. runs route only to their own flow tab and account", async () => {
    const { db, google } = setupEnv();
    (db.tables["flows"] as Row[]).push({ id: "FC", account_id: "ACC2", name: "Other", entry_node_id: "start" });
    (db.tables["flow_runs"] as Row[]).push({
      id: "R7", flow_id: "FC", account_id: "ACC2", contact_id: C1, status: "completed",
      vars: { name: "Z" }, started_at: "2024-03-01T09:00:00Z", ended_at: "2024-03-01T09:05:00Z",
    });
    const a = await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    const { getOrCreateCollection } = await import("@/lib/all-sheets/collections");
    const { ensureFlowTab } = await import("@/lib/all-sheets/flow-tabs");
    const { collection: c2 } = await getOrCreateCollection(asSupabase(db), "ACC2", "completed", "tok");
    await ensureFlowTab(asSupabase(db), c2, "completed", "FC", "Other", "tok");
    google.appendCalls = [];

    await handleAllSheetCompletion(asSupabase(db), "R1", { getToken: async () => "tok" });
    await handleAllSheetCompletion(asSupabase(db), "R7", { getToken: async () => "tok" });

    const urls = google.appendCalls.map((c) => c.url);
    const toA = urls.filter((u) => u.includes(`/spreadsheets/${a.collection.spreadsheet_id}/values/`));
    const toC2 = urls.filter((u) => u.includes(`/spreadsheets/${c2.spreadsheet_id}/values/`));
    expect(toA.length).toBeGreaterThan(0);
    expect(toC2.length).toBeGreaterThan(0);
    // Flow B title never appears in a Flow A append and vice versa.
    for (const u of toA) expect(decodeURIComponent(u)).not.toContain("Honeymoon");
    assertProtectedTablesUntouched(db);
  });
});

  it("importing Flow A appends only to Flow A's tab range (check 7)", async () => {
    const { db, google } = setupEnv();
    const a = await addFlow(db, "completed", FA, "Kashmir Winter + New Year Ad Chat Flow");
    await addFlow(db, "completed", FB, "Honeymoon");
    google.appendCalls = [];

    const { imported } = await importAllSheetCompleted(asSupabase(db), a.collection, a.tab, "tok");
    expect(imported).toBe(2); // R1 + R2

    const titleA = quoteSheetTitle(a.tab.worksheet_title);
    const titleB = quoteSheetTitle("Honeymoon");
    const urls = google.appendCalls.map((c) => c.url);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toContain(encodeURIComponent(titleA).replace(/%20/g, "%20"));
    expect(urls.some((u) => u.includes(titleB) || u.includes(encodeURIComponent(titleB)))).toBe(false);
    // Own tab state stamped for exactly the imported runs.
    expect(db.tables["all_sheet_tab_run_state"]?.length ?? 0).toBe(2);
    assertProtectedTablesUntouched(db);
  });

  it("incomplete refresh uses own tab state, never the existing watermark (checks 2+9)", async () => {
    const { db, google } = setupEnv();
    const { collection, tab } = await addFlow(db, "incomplete", FA, "Kashmir Winter + New Year Ad Chat Flow");
    google.appendCalls = [];

    const first = await refreshAllSheetIncomplete(asSupabase(db), collection, tab, "tok");
    expect(first.imported).toBe(1); // R4 only
    const second = await refreshAllSheetIncomplete(asSupabase(db), collection, tab, "tok");
    expect(second.imported).toBe(0); // idempotent via own state

    const touched = db.touchedTables();
    expect(touched.has("flow_incomplete_sheet_configs")).toBe(false);
    expect(db.loggedText()).not.toContain("incomplete_synced_at");
    // flow_runs was read as source data (allowed) — sanity that the
    // assertion above is meaningful rather than vacuous.
    expect(touched.has("flow_runs")).toBe(true);
    assertProtectedTablesUntouched(db);
  });

  it("incomplete heal writes literal A1 ranges, never URL-encoded (reported 400)", async () => {
    const { db, google } = setupEnv();
    const { collection, tab } = await addFlow(db, "incomplete", FA, "From Kashmir Diwali Ad Chat Flow");
    // A later run carries a brand-new answer key, forcing the heal path
    // (insert columns + header-cell write) on the next refresh.
    (db.tables["flow_runs"] as Row[]).push({
      id: "R5",
      flow_id: FA,
      contact_id: C1,
      status: "timed_out",
      vars: { name: "Zed", city: "Leh" },
      started_at: "2024-02-05T00:00:00Z",
      ended_at: "2024-02-05T01:05:00Z",
    });

    const { imported } = await refreshAllSheetIncomplete(asSupabase(db), collection, tab, "tok");
    expect(imported).toBe(2); // R4 + R5

    expect(google.valueBatchBodies.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(google.valueBatchBodies);
    // The logical range keeps the real title; %20 must never appear.
    expect(serialized).toContain("'From Kashmir Diwali Ad Chat Flow'!");
    expect(serialized).not.toContain("%20");
    expect(serialized).not.toContain("From%20Kashmir");
    // The new key healed in; the promoted Name key did not duplicate.
    const stored = (db.tables["all_sheet_flow_tabs"] as Row[]).find((t) => t["id"] === tab.id);
    expect(stored?.["answer_columns"]).toContain("city");
    expect(((stored?.["answer_columns"] as string[]) ?? []).filter((k) => k === "name")).toHaveLength(0);
    assertProtectedTablesUntouched(db);
  });

  it("completed heal after a column rename writes literal A1 ranges", async () => {
    const { db, google } = setupEnv();
    const { collection, tab } = await addFlow(db, "completed", FA, "Kashmir + Katra");

    // Rename a question after the header was written, then import: the
    // rename must be patched in place with a literal quoted range.
    const nodes = db.tables["flow_nodes"] as Row[];
    const q = nodes.find((n) => n["flow_id"] === FA && n["node_key"] === "q_guests");
    if (q) q["config"] = { ...(q["config"] as Row), sheet_column_name: "Party Size" };

    const { imported } = await importAllSheetCompleted(asSupabase(db), collection, tab, "tok");
    expect(imported).toBe(2);

    expect(google.valueBatchBodies.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(google.valueBatchBodies);
    expect(serialized).toContain("'Kashmir + Katra'!");
    expect(serialized).not.toContain("%20");
    expect(serialized).not.toContain("Kashmir%20");
    assertProtectedTablesUntouched(db);
  });
