// ---------------------------------------------------------------------------
// Tests for the INTERNAL cross-account Flow copy service.
//
// The service copies a flow into another account with fresh IDs and
// remapped account-owned references. These tests assert independence,
// tenant safety, and rollback using an in-memory fake of the narrow
// CopyDbClient surface (no Supabase needed).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  copyFlowAcrossAccounts,
  isMediaPlaceholder,
  parseStorageUrl,
  remapNodeConfigForTarget,
  type CopyDbClient,
  type RemapContext,
  type TagRef,
} from "./cross-account-copy";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const FLOW_A = "11111111-1111-1111-1111-111111111111";
const UA = "a0000000-0000-0000-0000-000000000001";
const UB = "b0000000-0000-0000-0000-000000000002";
const TAG_A_VIP = "aa000000-0000-0000-0000-0000000000a1";
const TAG_B_VIP = "bb000000-0000-0000-0000-0000000000b1";

interface FakeOpts {
  failNodeInsert?: boolean;
  failStorageCopy?: boolean;
}

function seedTables() {
  return {
    accounts: [{ id: A }, { id: B }],
    profiles: [
      { user_id: UA, account_id: A },
      { user_id: UB, account_id: B },
    ],
    flows: [
      {
        id: FLOW_A,
        account_id: A,
        user_id: UA,
        name: "Lead Qualification",
        description: "Qualifies leads",
        status: "active",
        trigger_type: "keyword",
        trigger_config: { keywords: ["hi"] },
        entry_node_id: "start",
        fallback_policy: { on_unknown_reply: "reprompt" },
        execution_count: 9,
        last_executed_at: "2026-01-01T00:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    flow_nodes: [
      {
        id: "node-a-1",
        flow_id: FLOW_A,
        node_key: "start",
        node_type: "start",
        config: { next_node_key: "tag" },
        position_x: 0,
        position_y: 0,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "node-a-2",
        flow_id: FLOW_A,
        node_key: "tag",
        node_type: "set_tag",
        config: { mode: "add", tag_id: TAG_A_VIP, next_node_key: "media" },
        position_x: 10,
        position_y: 10,
        created_at: "2026-01-01T00:00:01Z",
      },
      {
        id: "node-a-3",
        flow_id: FLOW_A,
        node_key: "media",
        node_type: "send_media",
        config: {
          media_type: "document",
          media_url:
            "https://cdn.test/storage/v1/object/public/flow-media/account-OLD/1-invoice.pdf",
          filename: "invoice.pdf",
          next_node_key: "hand",
        },
        position_x: 20,
        position_y: 20,
        created_at: "2026-01-01T00:00:02Z",
      },
      {
        id: "node-a-4",
        flow_id: FLOW_A,
        node_key: "hand",
        node_type: "handoff",
        config: { assign_to: UB, note: "hi" },
        position_x: 30,
        position_y: 30,
        created_at: "2026-01-01T00:00:03Z",
      },
      {
        id: "node-a-5",
        flow_id: FLOW_A,
        node_key: "hook",
        node_type: "send_message",
        config: {
          text: "done",
          webhook: { enabled: true, url: "https://hooks.test/x", secret: "s3cret" },
          next_node_key: "hand",
        },
        position_x: 40,
        position_y: 40,
        created_at: "2026-01-01T00:00:04Z",
      },
    ],
    tags: [
      { id: TAG_A_VIP, account_id: A, name: "VIP" },
      { id: TAG_B_VIP, account_id: B, name: "VIP" },
      { id: "bb000000-0000-0000-0000-0000000000b9", account_id: B, name: "Other" },
    ],
  };
}

function makeFake(seed: ReturnType<typeof seedTables>, opts: FakeOpts = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    accounts: [...seed.accounts],
    profiles: [...seed.profiles],
    flows: seed.flows.map((f) => ({ ...f })),
    flow_nodes: seed.flow_nodes.map((n) => ({ ...n, config: { ...n.config } })),
    tags: [...seed.tags],
  };
  const storageCalls: Array<{ bucket: string; from: string; to: string }> = [];
  let nodeSeq = 0;

  const table = (name: string) => {
    const filters: Array<[string, unknown]> = [];
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return b;
      },
      order: () => b,
      maybeSingle: async () => ({
        data:
          (tables[name] ?? []).find((r) =>
            filters.every(([c, v]) => r[c] === v),
          ) ?? null,
        error: null,
      }),
      single: async () => {
        const row = (tables[name] ?? []).find((r) =>
          filters.every(([c, v]) => r[c] === v),
        );
        return row
          ? { data: row, error: null }
          : { data: null, error: { message: "none" } };
      },
      insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        const list = Array.isArray(rows) ? rows : [rows];
        if (name === "flows") {
          const row = { ...list[0], id: `new-flow-${tables.flows.length}` };
          tables.flows.push(row);
          return {
            select: () => ({
              single: async () => ({ data: row, error: null }),
            }),
          };
        }
        if (name === "flow_nodes") {
          if (opts.failNodeInsert) {
            return {
              select: () => ({
                single: async () => ({ data: null, error: { message: "x" } }),
              }),
              then: (
                onF: (v: unknown) => unknown,
              ) => onF({ data: null, error: { message: "node boom" } }),
            };
          }
          for (const r of list) {
            nodeSeq += 1;
            tables.flow_nodes.push({ ...r, id: `new-node-${nodeSeq}` });
          }
          return {
            select: () => ({
              single: async () => ({ data: null, error: null }),
            }),
            then: (onF: (v: unknown) => unknown) =>
              onF({ data: null, error: null }),
          };
        }
        return {
          select: () => ({
            single: async () => ({ data: null, error: null }),
          }),
          then: (onF: (v: unknown) => unknown) =>
            onF({ data: null, error: null }),
        };
      },
      delete: () => ({
        eq: async (col: string, val: unknown) => {
          tables[name] = (tables[name] ?? []).filter((r) => r[col] !== val);
          // CASCADE: deleting a flow removes its nodes.
          if (name === "flows") {
            tables.flow_nodes = tables.flow_nodes.filter(
              (n) => n.flow_id !== val,
            );
          }
          return { error: null };
        },
      }),
      then: (onF: (v: unknown) => unknown) => {
        let rows = tables[name] ?? [];
        for (const [c, v] of filters) rows = rows.filter((r) => r[c] === v);
        return onF({ data: rows, error: null });
      },
    };
    return b;
  };

  const db = {
    from: (name: string) => table(name),
    storage: {
      from: (bucket: string) => ({
        copy: async (fromPath: string, toPath: string) => {
          storageCalls.push({ bucket, from: fromPath, to: toPath });
          if (opts.failStorageCopy) return { error: { message: "copy boom" } };
          return { error: null };
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://cdn.test/storage/v1/object/public/${bucket}/${path}` },
        }),
      }),
    },
    __tables: tables,
    __storageCalls: storageCalls,
  };
  return db as unknown as CopyDbClient & {
    __tables: typeof tables;
    __storageCalls: typeof storageCalls;
  };
}

function ownerInput(overrides: Record<string, unknown> = {}) {
  return {
    callerUserId: UA,
    callerAccountId: A,
    callerRole: "owner",
    sourceFlowId: FLOW_A,
    targetAccountId: B,
    ...overrides,
  };
}

describe("remapNodeConfigForTarget (pure)", () => {
  const ctxFor = (): RemapContext => ({
    targetTagsByName: new Map<string, TagRef>([
      ["vip", { id: TAG_B_VIP, name: "VIP" }],
    ]),
    targetMemberUserIds: new Set([UB]),
    warnings: [],
  });
  const srcTags = new Map<string, TagRef>([
    [TAG_A_VIP, { id: TAG_A_VIP, name: "VIP" }],
  ]);

  it("remaps set_tag to the target tag id, never the source id", () => {
    const ctx = ctxFor();
    const out = remapNodeConfigForTarget(
      "set_tag",
      "tag",
      { mode: "add", tag_id: TAG_A_VIP, next_node_key: "x" },
      srcTags,
      ctx,
    );
    expect(out.tag_id).toBe(TAG_B_VIP);
    expect(out.mode).toBe("add");
    expect(out.next_node_key).toBe("x");
    expect(ctx.warnings).toHaveLength(0);
  });

  it("clears unmapped tags with a warning (never keeps source ids)", () => {
    const ctx = ctxFor();
    const out = remapNodeConfigForTarget(
      "set_tag",
      "tag",
      { mode: "remove", tag_id: "unknown-id" },
      srcTags,
      ctx,
    );
    expect(out.tag_id).toBe("");
    expect(ctx.warnings).toHaveLength(1);
    expect(ctx.warnings[0]?.field).toBe("tag_id");
  });

  it("remaps condition tag subjects the same way", () => {
    const ctx = ctxFor();
    const out = remapNodeConfigForTarget(
      "condition",
      "cond",
      { subject: "tag", subject_key: TAG_A_VIP, operator: "present" },
      srcTags,
      ctx,
    );
    expect(out.subject_key).toBe(TAG_B_VIP);
    expect(out.subject).toBe("tag");
  });

  it("keeps member assignees, clears outsiders", () => {
    const keep = remapNodeConfigForTarget(
      "handoff",
      "hand",
      { assign_to: UB },
      srcTags,
      ctxFor(),
    );
    expect(keep.assign_to).toBe(UB);
    const ctx = ctxFor();
    const cleared = remapNodeConfigForTarget(
      "handoff",
      "hand",
      { assign_to: "outsider" },
      srcTags,
      ctx,
    );
    expect(cleared.assign_to).toBeNull();
    expect(ctx.warnings.some((w) => w.field === "assign_to")).toBe(true);
  });

  it("keeps webhook urls but strips secrets", () => {
    const ctx = ctxFor();
    const out = remapNodeConfigForTarget(
      "send_message",
      "m",
      { text: "hi", webhook: { enabled: true, url: "https://h.test", secret: "s" } },
      srcTags,
      ctx,
    );
    const hook = out.webhook as Record<string, unknown>;
    expect(hook.url).toBe("https://h.test");
    expect(hook.secret).toBe("");
    expect(ctx.warnings.some((w) => w.field === "webhook.secret")).toBe(true);
  });

  it("marks flow-media urls for re-ownership, passes external urls through", () => {
    const ctx = ctxFor();
    const out = remapNodeConfigForTarget(
      "send_media",
      "media",
      {
        media_type: "document",
        media_url:
          "https://cdn.test/storage/v1/object/public/flow-media/account-X/f.pdf",
      },
      srcTags,
      ctx,
    );
    expect(isMediaPlaceholder(out.media_url)).toBe(true);
    const ext = remapNodeConfigForTarget(
      "send_cta_url",
      "cta",
      { button_url: "https://example.com/x" },
      srcTags,
      ctx,
    );
    expect(ext.button_url).toBe("https://example.com/x");
  });

  it("parses storage urls (and rejects non-storage urls)", () => {
    expect(
      parseStorageUrl("https://cdn.test/storage/v1/object/public/flow-media/a/b.pdf"),
    ).toEqual({ bucket: "flow-media", path: "a/b.pdf" });
    expect(parseStorageUrl("https://example.com/x")).toBeNull();
    expect(parseStorageUrl("not a url")).toBeNull();
  });
});

describe("copyFlowAcrossAccounts", () => {
  it("copies A → B with fresh ids, draft status, and remapped refs", async () => {
    const db = makeFake(seedTables());
    const before = JSON.stringify(db.__tables.flows[0]);

    const res = await copyFlowAcrossAccounts(db, ownerInput());

    expect(res.targetAccountId).toBe(B);
    expect(res.flowName).toBe("Lead Qualification - Copy");
    expect(res.nodeCount).toBe(5);
    // Parent is fresh + draft + target-owned.
    const created = db.__tables.flows.find((f) => f.id === res.targetFlowId);
    expect(created).toMatchObject({
      account_id: B,
      user_id: UA,
      status: "draft",
      execution_count: 0,
      last_executed_at: null,
      entry_node_id: "start",
      trigger_type: "keyword",
    });
    expect(res.targetFlowId).not.toBe(FLOW_A);
    // Nodes are fresh rows under the new flow with stable keys.
    const createdNodes = db.__tables.flow_nodes.filter(
      (n) => n.flow_id === res.targetFlowId,
    );
    expect(createdNodes).toHaveLength(5);
    expect(createdNodes.map((n) => n.node_key).sort()).toEqual(
      ["hand", "hook", "media", "start", "tag"],
    );
    for (const n of createdNodes) {
      expect(String(n.id)).not.toMatch(/^node-a-/);
    }
    // Edges still resolve inside the copy.
    const keys = new Set(createdNodes.map((n) => n.node_key));
    for (const n of createdNodes) {
      const next = (n.config as Record<string, unknown>).next_node_key;
      if (typeof next === "string" && next) {
        expect(keys.has(next)).toBe(true);
      }
    }
    // Tag remapped to B's VIP; no source tag id anywhere.
    const tagNode = createdNodes.find((n) => n.node_key === "tag");
    expect((tagNode?.config as Record<string, unknown>).tag_id).toBe(TAG_B_VIP);
    const blob = JSON.stringify(createdNodes.map((n) => n.config));
    expect(blob).not.toContain(TAG_A_VIP);
    expect(blob).not.toContain("account-OLD");
    // Media re-owned into the target folder.
    expect(db.__storageCalls).toHaveLength(1);
    expect(db.__storageCalls[0]?.to.startsWith(`account-${B}/`)).toBe(true);
    const mediaNode = createdNodes.find((n) => n.node_key === "media");
    expect((mediaNode?.config as Record<string, unknown>).media_url).toContain(
      `account-${B}/`,
    );
    // Member assignee kept; webhook secret stripped.
    const handNode = createdNodes.find((n) => n.node_key === "hand");
    expect((handNode?.config as Record<string, unknown>).assign_to).toBe(UB);
    const hookNode = createdNodes.find((n) => n.node_key === "hook");
    expect(
      ((hookNode?.config as Record<string, unknown>).webhook as Record<string, unknown>).secret,
    ).toBe("");
    // Source flow row untouched.
    expect(JSON.stringify(db.__tables.flows[0])).toBe(before);
    expect(
      db.__tables.flow_nodes.filter((n) => n.flow_id === FLOW_A),
    ).toHaveLength(5);
  });

  it("rejects a caller from an unrelated account (B cannot steal A's flow)", async () => {
    const db = makeFake(seedTables());
    await expect(
      copyFlowAcrossAccounts(
        db,
        ownerInput({ callerUserId: UB, callerAccountId: B, callerRole: "agent" }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(db.__tables.flows).toHaveLength(1);
  });

  it("rejects non-owners of the source account", async () => {
    const db = makeFake(seedTables());
    db.__tables.profiles.push({ user_id: "u-agent", account_id: A });
    await expect(
      copyFlowAcrossAccounts(
        db,
        ownerInput({ callerUserId: "u-agent", callerAccountId: A, callerRole: "agent" }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("fails safely on unknown flow, unknown target, and bad ids", async () => {
    const db = makeFake(seedTables());
    await expect(
      copyFlowAcrossAccounts(db, ownerInput({ sourceFlowId: "22222222-2222-2222-2222-222222222222" })),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      copyFlowAcrossAccounts(db, ownerInput({ targetAccountId: "33333333-3333-3333-3333-333333333333" })),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      copyFlowAcrossAccounts(db, ownerInput({ sourceFlowId: "nope" })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rolls back the parent when node inserts fail (no orphans)", async () => {
    const db = makeFake(seedTables(), { failNodeInsert: true });
    await expect(copyFlowAcrossAccounts(db, ownerInput())).rejects.toMatchObject({
      status: 500,
    });
    expect(db.__tables.flows).toHaveLength(1);
    expect(
      db.__tables.flow_nodes.filter((n) => (n.flow_id as string) !== FLOW_A),
    ).toHaveLength(0);
  });

  it("increments copy names on collision", async () => {
    const db = makeFake(seedTables());
    db.__tables.flows.push({
      id: "existing-copy",
      account_id: B,
      name: "Lead Qualification - Copy",
    });
    const res = await copyFlowAcrossAccounts(db, ownerInput());
    expect(res.flowName).toBe("Lead Qualification - Copy 2");
  });

  it("keeps the source URL with a warning when media re-ownership fails", async () => {
    const db = makeFake(seedTables(), { failStorageCopy: true });
    const res = await copyFlowAcrossAccounts(db, ownerInput());
    expect(res.warnings.some((w) => w.field === "media_url")).toBe(true);
    const mediaNode = db.__tables.flow_nodes.find(
      (n) => n.flow_id === res.targetFlowId && n.node_key === "media",
    );
    expect((mediaNode?.config as Record<string, unknown>).media_url).toContain(
      "account-OLD",
    );
  });

  it("target edits never affect the source (independent objects)", async () => {
    const db = makeFake(seedTables());
    const res = await copyFlowAcrossAccounts(db, ownerInput());
    const created = db.__tables.flow_nodes.find(
      (n) => n.flow_id === res.targetFlowId && n.node_key === "tag",
    );
    ((created?.config as Record<string, unknown>).tag_id as string) = "mutated";
    const source = db.__tables.flow_nodes.find((n) => n.id === "node-a-2");
    expect((source?.config as Record<string, unknown>).tag_id).toBe(TAG_A_VIP);
  });
});

describe("copyFlowAcrossAccounts — target-owner mode", () => {
  const targetOwnerInput = (overrides: Record<string, unknown> = {}) => ({
    callerUserId: UB,
    callerAccountId: B,
    callerRole: "owner",
    sourceFlowId: FLOW_A,
    targetAccountId: B,
    authorization: "target-owner" as const,
    ...overrides,
  });

  it("copies a foreign flow into the caller's own account as Draft", async () => {
    const db = makeFake(seedTables());
    const res = await copyFlowAcrossAccounts(db, targetOwnerInput());

    expect(res.targetAccountId).toBe(B);
    expect(res.flowName).toBe("Lead Qualification - Copy");
    const created = db.__tables.flows.find((f) => f.id === res.targetFlowId);
    expect(created).toMatchObject({
      account_id: B,
      user_id: UB,
      status: "draft",
      execution_count: 0,
    });
    expect(res.targetFlowId).not.toBe(FLOW_A);
    expect(
      db.__tables.flow_nodes.filter((n) => n.flow_id === res.targetFlowId),
    ).toHaveLength(5);
    // Tag remapped to the destination account's tag.
    const tagNode = db.__tables.flow_nodes.find(
      (n) => n.flow_id === res.targetFlowId && n.node_key === "tag",
    );
    expect((tagNode?.config as Record<string, unknown>).tag_id).toBe(TAG_B_VIP);
  });

  it("copies a same-account flow by ID without touching the source", async () => {
    const db = makeFake(seedTables());
    const before = JSON.stringify(
      db.__tables.flow_nodes.filter((n) => n.flow_id === FLOW_A),
    );
    const res = await copyFlowAcrossAccounts(
      db,
      targetOwnerInput({
        callerUserId: UA,
        callerAccountId: A,
        sourceFlowId: FLOW_A,
        targetAccountId: A,
      }),
    );
    expect(res.targetAccountId).toBe(A);
    expect(res.targetFlowId).not.toBe(FLOW_A);
    expect(
      JSON.stringify(db.__tables.flow_nodes.filter((n) => n.flow_id === FLOW_A)),
    ).toBe(before);
  });

  it("rejects non-owners before any source lookup", async () => {
    const db = makeFake(seedTables());
    await expect(
      copyFlowAcrossAccounts(
        db,
        targetOwnerInput({ callerRole: "admin" }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(db.__tables.flows).toHaveLength(1);
  });

  it("rejects a forged destination outside the caller's account", async () => {
    const db = makeFake(seedTables());
    await expect(
      copyFlowAcrossAccounts(
        db,
        targetOwnerInput({ targetAccountId: A }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(db.__tables.flows).toHaveLength(1);
  });

  it("returns 404 for unknown source IDs", async () => {
    const db = makeFake(seedTables());
    await expect(
      copyFlowAcrossAccounts(
        db,
        targetOwnerInput({ sourceFlowId: "22222222-2222-2222-2222-222222222222" }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(db.__tables.flows).toHaveLength(1);
  });
});
