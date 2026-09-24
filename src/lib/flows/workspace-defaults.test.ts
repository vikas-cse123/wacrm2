import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  applyVisibility,
  customFieldVisId,
  describeVisibilityMenu,
  toggleHiddenId,
} from "./workspace-visibility";
import type { WorkspaceField } from "./workspace-fields";
import {
  WORKSPACE_DEFAULT_FIELDS,
  ensureWorkspaceDefaultFields,
  isWorkspaceDefaultName,
} from "./workspace-defaults";

// ---------------------------------------------------------------------------
// Proof tests: Workspace default business columns (Assigned To … Final
// Remark). Provisioning writes ONLY workspace_fields rows — Sheets,
// flows, values, and unrelated architecture are never touched.
// ---------------------------------------------------------------------------

interface FakeStore {
  rows: Array<{ name: string; position: number }>;
  tablesTouched: string[];
  eqFilters: Array<[string, unknown]>;
  inserts: Array<Record<string, unknown>[]>;
  insertError: { code?: string; message: string } | null;
  failRead: boolean;
}

function fakeClient(store: FakeStore): SupabaseClient {
  const client = {
    from: (table: string) => {
      store.tablesTouched.push(table);
      return {
        select: () => ({
          eq: (col: string, val: unknown) => {
            store.eqFilters.push([col, val]);
            return {
              eq: async (col2: string, val2: unknown) => {
                store.eqFilters.push([col2, val2]);
                if (store.failRead) {
                  return { data: null, error: { message: "read failed" } };
                }
                return { data: store.rows, error: null };
              },
            };
          },
        }),
        insert: async (newRows: Array<Record<string, unknown>>) => {
          store.inserts.push(newRows);
          if (store.insertError) {
            return { data: null, error: store.insertError };
          }
          return { data: newRows, error: null };
        },
      };
    },
  };
  return client as unknown as SupabaseClient;
}

function newStore(
  rows: Array<{ name: string; position: number }> = [],
): FakeStore {
  return {
    rows,
    tablesTouched: [],
    eqFilters: [],
    inserts: [],
    insertError: null,
    failRead: false,
  };
}

/** Default-shaped WorkspaceField rows for visibility tests. */
function defaultFields(): WorkspaceField[] {
  return WORKSPACE_DEFAULT_FIELDS.map((spec, i) => ({
    id: `f-default-${i + 1}`,
    account_id: "acct-1",
    flow_id: "flow-1",
    name: spec.name,
    field_type: spec.field_type,
    position: i,
    options: spec.options,
    default_value: null,
    currency_code: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }));
}

describe("default business column spec", () => {
  it("defines exactly the 12 required columns in order", () => {
    expect(WORKSPACE_DEFAULT_FIELDS.map((f) => f.name)).toEqual([
      "Assigned To",
      "Call Status",
      "No. of Calls Tried",
      "Lead Quality",
      "Quotation / Package",
      "Follow-Up Status",
      "Last Contact Date",
      "Customer Response",
      "Next Follow-up Date & Time",
      "Next Action",
      "Reason for Lost Lead",
      "Final Remark",
    ]);
  });

  it("uses the required field types", () => {
    const byName = new Map(WORKSPACE_DEFAULT_FIELDS.map((f) => [f.name, f]));
    expect(byName.get("Assigned To")?.field_type).toBe("single_select");
    expect(byName.get("Call Status")?.field_type).toBe("single_select");
    expect(byName.get("No. of Calls Tried")?.field_type).toBe("number");
    expect(byName.get("Lead Quality")?.field_type).toBe("single_select");
    expect(byName.get("Quotation / Package")?.field_type).toBe("text");
    expect(byName.get("Follow-Up Status")?.field_type).toBe("single_select");
    expect(byName.get("Last Contact Date")?.field_type).toBe("date");
    expect(byName.get("Customer Response")?.field_type).toBe("text");
    expect(byName.get("Next Follow-up Date & Time")?.field_type).toBe(
      "datetime",
    );
    expect(byName.get("Next Action")?.field_type).toBe("text");
    expect(byName.get("Reason for Lost Lead")?.field_type).toBe(
      "single_select",
    );
    expect(byName.get("Final Remark")?.field_type).toBe("text");
  });

  it("carries the exact business options for select columns", () => {
    const byName = new Map(WORKSPACE_DEFAULT_FIELDS.map((f) => [f.name, f]));
    expect(byName.get("Call Status")?.options).toEqual([
      "Connected",
      "Not Answering",
      "Switched Off",
      "Busy",
      "Call Back Later",
      "Invalid Number",
    ]);
    expect(byName.get("Lead Quality")?.options).toEqual([
      "Hot",
      "Warm",
      "Cold",
      "Fake",
    ]);
    expect(byName.get("Follow-Up Status")?.options).toEqual([
      "Follow-up Pending",
      "Negotiation Going On",
      "Booked",
      "Lost",
      "No Plan",
    ]);
    expect(byName.get("Reason for Lost Lead")?.options).toEqual([
      "Budget Issue",
      "No Response",
      "Already Booked Elsewhere",
      "Date Issue",
      "Just Inquiry",
      "Travel Cancelled",
    ]);
    // Non-select columns take no options (validator rejects them).
    for (const name of [
      "No. of Calls Tried",
      "Quotation / Package",
      "Last Contact Date",
      "Customer Response",
      "Next Follow-up Date & Time",
      "Next Action",
      "Final Remark",
    ]) {
      expect(byName.get(name)?.options).toBeNull();
    }
  });

  it("recognizes default names deterministically (case-insensitive)", () => {
    expect(isWorkspaceDefaultName("Call Status")).toBe(true);
    expect(isWorkspaceDefaultName("  call status ")).toBe(true);
    expect(isWorkspaceDefaultName("My Custom Column")).toBe(false);
    expect(isWorkspaceDefaultName(null)).toBe(false);
  });
});

describe("ensureWorkspaceDefaultFields", () => {
  it("1. provisions all 12 defaults for a new flow (positions 0–11)", async () => {
    const store = newStore();
    const res = await ensureWorkspaceDefaultFields(
      fakeClient(store),
      "acct-1",
      "flow-1",
    );
    expect(res.created).toHaveLength(12);
    expect(store.inserts).toHaveLength(1);
    const rows = store.inserts[0];
    expect(rows.map((r) => r.name)).toEqual(
      WORKSPACE_DEFAULT_FIELDS.map((f) => f.name),
    );
    expect(rows.map((r) => r.position)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    for (const row of rows) {
      expect(row.account_id).toBe("acct-1");
      expect(row.flow_id).toBe("flow-1");
      expect(row.default_value).toBeNull();
      expect(row.currency_code).toBeNull();
    }
    // No duplicate option payloads: single bulk insert.
    expect(rows).toHaveLength(12);
  });

  it("10. is idempotent — a second call creates nothing", async () => {
    const store = newStore();
    const client = fakeClient(store);
    await ensureWorkspaceDefaultFields(client, "acct-1", "flow-1");
    // Simulate the rows now existing.
    store.rows = WORKSPACE_DEFAULT_FIELDS.map((f, i) => ({
      name: f.name,
      position: i,
    }));
    store.inserts = [];
    const res = await ensureWorkspaceDefaultFields(client, "acct-1", "flow-1");
    expect(res.created).toEqual([]);
    expect(store.inserts).toHaveLength(0);
  });

  it("9/11. keeps existing custom fields intact and appends after them", async () => {
    const store = newStore([
      { name: "My Tracker", position: 0 },
      { name: "VIP Flag", position: 4 },
    ]);
    const res = await ensureWorkspaceDefaultFields(
      fakeClient(store),
      "acct-1",
      "flow-1",
    );
    expect(res.created).toHaveLength(12);
    const rows = store.inserts[0];
    // Appended after the current max position — existing order kept.
    expect(rows[0].position).toBe(5);
    expect(rows[11].position).toBe(16);
  });

  it("10. never duplicates a user field sharing a default name", async () => {
    const store = newStore([
      { name: "Call Status", position: 0 },
      { name: "  lead quality  ", position: 1 },
    ]);
    const res = await ensureWorkspaceDefaultFields(
      fakeClient(store),
      "acct-1",
      "flow-1",
    );
    // Two suppressed, ten created — the user's own rows untouched
    // (provisioning only inserts; it never updates or deletes).
    expect(res.created).toHaveLength(10);
    expect(res.created).not.toContain("Call Status");
    expect(res.created).not.toContain("Lead Quality");
    expect(store.inserts[0]).toHaveLength(10);
  });

  it("survives a concurrent-provisioner race (unique-index conflict)", async () => {
    const store = newStore();
    store.insertError = { code: "23505", message: "duplicate" };
    const res = await ensureWorkspaceDefaultFields(
      fakeClient(store),
      "acct-1",
      "flow-1",
    );
    // Attempted the insert; the conflict is swallowed, not surfaced.
    expect(store.inserts).toHaveLength(1);
    expect(res.created).toHaveLength(12);
  });

  it("surfaces real failures so callers can degrade gracefully", async () => {
    const readStore = newStore();
    readStore.failRead = true;
    await expect(
      ensureWorkspaceDefaultFields(fakeClient(readStore), "acct-1", "flow-1"),
    ).rejects.toThrow(/read failed/);

    const writeStore = newStore();
    writeStore.insertError = { code: "500", message: "boom" };
    await expect(
      ensureWorkspaceDefaultFields(fakeClient(writeStore), "acct-1", "flow-1"),
    ).rejects.toThrow(/boom/);
  });

  it("15/16. touches only workspace_fields, scoped to the flow's account", async () => {
    const store = newStore();
    await ensureWorkspaceDefaultFields(fakeClient(store), "acct-9", "flow-9");
    // No flows / flow_nodes / sheets / values tables ever touched.
    expect(new Set(store.tablesTouched)).toEqual(
      new Set(["workspace_fields"]),
    );
    expect(store.eqFilters).toContainEqual(["account_id", "acct-9"]);
    expect(store.eqFilters).toContainEqual(["flow_id", "flow-9"]);
  });
});

describe("default fields in the existing visibility mechanism", () => {
  it("2/3/4. Completed and Incomplete share one config: all 12 visible initially", () => {
    const fields = defaultFields();
    const model = describeVisibilityMenu([], fields);
    // Searchable Columns manager lists every default, none locked.
    expect(model.custom).toHaveLength(12);
    expect(model.custom.every((c) => c.locked === false)).toBe(true);
    // Default state (no hidden ids — same key for both views).
    const applied = applyVisibility([], fields, []);
    expect(applied.customFields).toHaveLength(12);
    expect(applied.leadSourceVisible).toBe(true);
  });

  it("13. core fields stay locked; defaults never join them", () => {
    const model = describeVisibilityMenu(
      [
        { key: "submission_time", label: "Submission Time", system: true },
        { key: "name", label: "Name", system: true },
        { key: "phone", label: "Phone Number", system: true },
      ],
      defaultFields(),
    );
    expect(model.core.map((c) => c.label)).toEqual([
      "Row",
      "Submission Time",
      "Name",
      "Phone Number",
    ]);
    expect(model.core.every((c) => c.locked)).toBe(true);
    expect(
      model.custom.some((c) => c.locked || model.core.some((k) => k.id === c.id)),
    ).toBe(false);
  });

  it("5/7. hides one, several, or all 12 — and restores each in place", () => {
    const fields = defaultFields();
    const ids = fields.map((f) => customFieldVisId(f.id));

    let hidden = toggleHiddenId([], ids[0]);
    expect(applyVisibility([], fields, hidden).customFields).toHaveLength(11);

    hidden = toggleHiddenId(hidden, ids[1]);
    hidden = toggleHiddenId(hidden, ids[2]);
    let applied = applyVisibility([], fields, hidden);
    expect(applied.customFields).toHaveLength(9);

    hidden = [...ids];
    applied = applyVisibility([], fields, hidden);
    expect(applied.customFields).toHaveLength(0);

    // Restore one: it returns to its ORIGINAL position, not appended.
    hidden = toggleHiddenId(hidden, ids[5]);
    applied = applyVisibility([], fields, hidden);
    expect(applied.customFields.map((f) => f.name)).toEqual([
      "Follow-Up Status",
    ]);

    // Show all / reset path.
    applied = applyVisibility([], fields, []);
    expect(applied.customFields.map((f) => f.name)).toEqual(
      fields.map((f) => f.name),
    );
  });

  it("6/8. hiding never deletes the field or its data", () => {
    const fields = defaultFields();
    const hidden = fields.map((f) => customFieldVisId(f.id));
    const before = fields.length;
    applyVisibility([], fields, hidden);
    // Definitions array untouched — nothing removed, order intact.
    expect(fields).toHaveLength(before);
    expect(fields.map((f) => f.name)).toEqual(
      WORKSPACE_DEFAULT_FIELDS.map((f) => f.name),
    );
  });

  it("14. Lead Source stays a separate, final column", () => {
    const model = describeVisibilityMenu([], defaultFields());
    expect(model.leadSource).toMatchObject({
      id: "lead_source",
      locked: false,
    });
    expect(
      model.custom.some((c) => c.id === model.leadSource.id),
    ).toBe(false);
  });
});

describe("console hygiene", () => {
  it("does not log during normal provisioning", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await ensureWorkspaceDefaultFields(
        fakeClient(newStore()),
        "acct-1",
        "flow-1",
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
