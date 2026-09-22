/**
 * INTERNAL cross-account Flow copy — server-only, no UI exposure.
 *
 * Copies any flow into any account, remapping every account-owned
 * reference so the target receives a genuinely independent, executable
 * flow. There is deliberately no button, menu item, setting, tooltip,
 * or help text for this anywhere in the product; the only entry point
 * is POST /api/internal/flows/copy (undocumented, owner-gated).
 *
 * Authorization model (see route — "hidden" is NOT the security):
 *   - "source-owner" (default): the caller must be `owner` of the
 *     SOURCE account (resolved from their own RLS-readable profile,
 *     never from client input) — outbound owner-consent. A caller
 *     from an unrelated account learns nothing (404) and changes
 *     nothing (403 on forged ownership).
 *   - "target-owner": the caller must be `owner` of the TARGET
 *     account, which must equal their own account (enforced here,
 *     so the client cannot override the destination). The source
 *     may belong to any account. Used by the self-service
 *     copy-to-current-account endpoint: non-owners fail before any
 *     source lookup (no existence oracle), unknown IDs read as 404.
 *
 * Reference policy per node config (verified against engine.ts):
 *   - set_tag.tag_id / condition(subject=tag).subject_key: match the
 *     target account's tag by name (exact, then case-insensitive).
 *     No match → cleared to "" + warning (the engine no-ops on
 *     dangling IDs, and validation blocks activation until fixed —
 *     strictly safer than pointing at the source account's tag).
 *   - handoff.assign_to (agent user_id): kept only if that user is a
 *     member of the target account, else cleared (engine then leaves
 *     the conversation unassigned — its built-in safe fallback).
 *   - send_media.media_url + header_image_url on flow-media Storage
 *     URLs: object copied into the target's `account-<id>/` folder
 *     and the config repointed. External https URLs pass through
 *     untouched (authored links, not account resources).
 *   - per-node webhook {url, secret}: URL kept, secret CLEARED +
 *     warning (the secret HMAC-signs dispatches; copying it could
 *     hand Account B a credential for Account A's endpoint).
 *   - recipient_email (custom), button_url, texts, var_keys,
 *     conditions on vars/fields: copied verbatim (authored data,
 *     not credentials).
 *   - google_sheets_sync: the link lives in flow_sheet_configs, which
 *     is deliberately NOT copied (same as same-account duplicate) —
 *     the node stays inert until relinked; flagged in warnings.
 *
 * Explicitly NOT copied: flow_runs, flow_run_events, execution
 * counters/timestamps (fresh), flow_sheet_configs, google
 * connections, email jobs, webhook logs, service-role keys, Meta
 * tokens. Status is forced to 'draft' so a copy never auto-runs.
 *
 * Atomicity follows the duplicate-route precedent (no multi-
 * statement transaction primitive in this stack): parent insert,
 * then node inserts; any node failure deletes the parent (CASCADE
 * removes partial nodes) and surfaces 500.
 */

import { buildMediaPath } from "@/lib/storage/upload-media";
import { uniqueCopyName } from "./duplicate";

export interface CopyWarning {
  node_key: string;
  field: string;
  reason: string;
}

export interface CrossAccountCopyResult {
  targetFlowId: string;
  targetAccountId: string;
  flowName: string;
  nodeCount: number;
  warnings: CopyWarning[];
}

export class CopyFlowError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CopyFlowError";
    this.status = status;
  }
}

/** Buckets whose objects are re-owned on copy (public media). */
const COPYABLE_MEDIA_BUCKETS = new Set(["flow-media"]);

/** Config keys holding a flow-media image URL per node type. */
const MEDIA_URL_KEYS: Record<string, string[]> = {
  send_media: ["media_url"],
  send_buttons: ["header_image_url"],
  send_list: ["header_image_url"],
  send_cta_url: ["header_image_url"],
};

export interface TagRef {
  id: string;
  name: string;
}

export interface RemapContext {
  /** Target tags keyed by lower-cased name. */
  targetTagsByName: Map<string, TagRef>;
  /** user_ids holding membership in the target account. */
  targetMemberUserIds: Set<string>;
  warnings: CopyWarning[];
}

function lookupTargetTag(
  sourceTagId: string,
  sourceTagsById: Map<string, TagRef>,
  ctx: RemapContext,
  nodeKey: string,
  field: string,
): string {
  const source = sourceTagsById.get(sourceTagId);
  const candidates = source ? [source.name, source.name.toLowerCase()] : [];
  for (const key of candidates) {
    const match =
      ctx.targetTagsByName.get(key) ?? ctx.targetTagsByName.get(key.toLowerCase());
    if (match) return match.id;
  }
  ctx.warnings.push({
    node_key: nodeKey,
    field,
    reason: source
      ? `tag "${source.name}" has no equivalent in the target account — cleared; pick a tag before activating`
      : `tag id is not a tag in the source account — cleared`,
  });
  return "";
}

/**
 * Parse a public Supabase Storage URL into {bucket, path}, or null
 * for external/arbitrary URLs (which pass through untouched).
 */
export function parseStorageUrl(url: string): { bucket: string; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = /^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/.exec(parsed.pathname);
  if (!match) return null;
  return { bucket: match[1]!, path: match[2]! };
}

/**
 * Remap one node's config for the target account. Pure except for
 * pushing into ctx.warnings. Never mutates its input.
 */
export function remapNodeConfigForTarget(
  nodeType: string,
  nodeKey: string,
  config: Record<string, unknown>,
  sourceTagsById: Map<string, TagRef>,
  ctx: RemapContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };

  if (nodeType === "set_tag" && typeof out.tag_id === "string" && out.tag_id) {
    out.tag_id = lookupTargetTag(out.tag_id, sourceTagsById, ctx, nodeKey, "tag_id");
  }

  if (
    nodeType === "condition" &&
    out.subject === "tag" &&
    typeof out.subject_key === "string" &&
    out.subject_key
  ) {
    out.subject_key = lookupTargetTag(out.subject_key, sourceTagsById, ctx, nodeKey, "subject_key");
  }

  if (nodeType === "handoff" && typeof out.assign_to === "string" && out.assign_to) {
    if (!ctx.targetMemberUserIds.has(out.assign_to)) {
      ctx.warnings.push({
        node_key: nodeKey,
        field: "assign_to",
        reason: "assignee is not a member of the target account — cleared (conversation will stay unassigned)",
      });
      out.assign_to = null;
    }
  }

  if (
    out.webhook &&
    typeof out.webhook === "object" &&
    !Array.isArray(out.webhook)
  ) {
    const hook = out.webhook as Record<string, unknown>;
    if (typeof hook.secret === "string" && hook.secret) {
      out.webhook = { ...hook, secret: "" };
      ctx.warnings.push({
        node_key: nodeKey,
        field: "webhook.secret",
        reason: "webhook secret not transferred (would leak the source endpoint credential) — re-enter it in the target",
      });
    }
  }

  // Media re-ownership is async (Storage copy); mark flow-media URLs
  // here with a placeholder the service resolves before inserting.
  // Anything else (external https) passes through untouched.
  for (const key of MEDIA_URL_KEYS[nodeType] ?? []) {
    const value = out[key];
    if (typeof value !== "string" || !value) continue;
    const parsed = parseStorageUrl(value);
    if (parsed && COPYABLE_MEDIA_BUCKETS.has(parsed.bucket)) {
      out[key] = { __copyMedia__: { bucket: parsed.bucket, path: parsed.path } };
    }
  }

  if (nodeType === "google_sheets_sync") {
    ctx.warnings.push({
      node_key: nodeKey,
      field: "sheet_link",
      reason: "Google Sheet link lives outside the flow and was not copied — relink the sheet in the target account",
    });
  }

  return out;
}

export interface MediaPlaceholder {
  __copyMedia__: { bucket: string; path: string };
}

export function isMediaPlaceholder(value: unknown): value is MediaPlaceholder {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).__copyMedia__ === "object"
  );
}

// ------------------------------------------------------------
// Minimal client surface the service needs (real supabaseAdmin()
// in production, in-memory fakes in tests).
// ------------------------------------------------------------

export interface CopyDbClient {
  from: (table: string) => {
    select: (cols: string) => QueryChain;
    insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => InsertChain;
    delete: () => { eq: (col: string, val: unknown) => Promise<{ error: unknown }> };
  };
  storage: {
    from: (bucket: string) => {
      copy: (fromPath: string, toPath: string) => Promise<{ error: unknown }>;
      getPublicUrl: (path: string) => { data: { publicUrl: string } };
    };
  };
}

interface QueryChain {
  eq: (col: string, val: unknown) => QueryChain;
  order: (col: string, opts?: { ascending?: boolean }) => QueryChain;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  single: () => Promise<{ data: unknown; error: unknown }>;
  then: <T, R>(
    onF: (v: { data: unknown; error: unknown }) => T | Promise<T>,
    onR?: (e: unknown) => R | Promise<R>,
  ) => Promise<T | R>;
}

interface InsertChain {
  select: () => {
    single: () => Promise<{ data: unknown; error: unknown }>;
  };
  then: <T, R>(
    onF: (v: { data: unknown; error: unknown }) => T | Promise<T>,
    onR?: (e: unknown) => R | Promise<R>,
  ) => Promise<T | R>;
}

export interface CopyFlowInput {
  callerUserId: string;
  /** Resolved from the caller's own RLS-readable profile — never client claims. */
  callerAccountId: string;
  callerRole: string;
  sourceFlowId: string;
  targetAccountId: string;
  /**
   * "source-owner" (default): caller must own the SOURCE account.
   * "target-owner": caller must own the TARGET account, which must
   * equal their own account — the client cannot choose a destination.
   */
  authorization?: "source-owner" | "target-owner";
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function one<T>(chain: QueryChain): Promise<{ data: T | null }> {
  const { data } = await chain.maybeSingle();
  return { data: data as T | null };
}

async function all<T>(chain: QueryChain): Promise<T[]> {
  const res = (await chain) as unknown as { data: unknown };
  return Array.isArray(res.data) ? (res.data as T[]) : [];
}

export async function copyFlowAcrossAccounts(
  db: CopyDbClient,
  input: CopyFlowInput,
): Promise<CrossAccountCopyResult> {
  const { callerUserId, callerAccountId, callerRole, sourceFlowId, targetAccountId } = input;
  const authorization = input.authorization ?? "source-owner";

  if (!UUID_RE.test(sourceFlowId) || !UUID_RE.test(targetAccountId)) {
    throw new CopyFlowError(400, "Invalid flow or account id.");
  }

  // Target-owner mode pins the destination to the caller's own
  // account up front: a forged targetAccountId fails before any
  // source lookup (no existence oracle for non-owners either —
  // the role check below also precedes the lookup).
  if (authorization === "target-owner") {
    if (callerRole !== "owner" || targetAccountId !== callerAccountId) {
      throw new CopyFlowError(403, "Not authorized to copy this flow.");
    }
  }

  // Source flow (privileged read — ownership is checked explicitly
  // below, never via RLS, since the caller may act across tenants).
  const { data: source } = await one<{
    id: string;
    account_id: string;
    name: string;
    description: string | null;
    trigger_type: string;
    trigger_config: unknown;
    entry_node_id: string | null;
    fallback_policy: unknown;
  }>(db.from("flows").select("*").eq("id", sourceFlowId));
  if (!source) throw new CopyFlowError(404, "Source flow not found.");

  // Outbound owner-consent (source-owner mode): only an owner of
  // the SOURCE account may push its flows elsewhere. A caller from
  // an unrelated account fails here even knowing both IDs (unknown
  // flow reads as 404 above when it truly doesn't exist;
  // wrong-account reads as 403 — never disclosing which).
  // Target-owner mode already authorized above (caller owns the
  // destination, which is their own account).
  if (
    authorization === "source-owner" &&
    (source.account_id !== callerAccountId || callerRole !== "owner")
  ) {
    throw new CopyFlowError(403, "Not authorized to copy this flow.");
  }

  // Target must be a real account (and never silently the source's
  // data — every write below stamps targetAccountId explicitly).
  const { data: targetAccount } = await one<{ id: string }>(
    db.from("accounts").select("id").eq("id", targetAccountId),
  );
  if (!targetAccount) throw new CopyFlowError(404, "Target account not found.");

  // Reference data: source nodes + both tag maps + target members +
  // target names (for collision-free naming).
  const nodes = await all<{
    node_key: string;
    node_type: string;
    config: Record<string, unknown>;
    position_x: number;
    position_y: number;
  }>(
    db
      .from("flow_nodes")
      .select("*")
      .eq("flow_id", sourceFlowId)
      .order("created_at", { ascending: true }),
  );

  const [sourceTagRows, targetTagRows, memberRows, nameRows] = await Promise.all([
    all<{ id: unknown; name: unknown }>(
      db.from("tags").select("id, name").eq("account_id", source.account_id),
    ),
    all<{ id: unknown; name: unknown }>(
      db.from("tags").select("id, name").eq("account_id", targetAccountId),
    ),
    all<{ user_id: unknown }>(
      db.from("profiles").select("user_id").eq("account_id", targetAccountId),
    ),
    all<{ name: unknown }>(
      db.from("flows").select("name").eq("account_id", targetAccountId),
    ),
  ]);
  const sourceTagsById = new Map<string, TagRef>();
  for (const r of sourceTagRows) {
    if (typeof r.id === "string" && typeof r.name === "string") {
      sourceTagsById.set(r.id, { id: r.id, name: r.name });
    }
  }
  const targetTagsByName = new Map<string, TagRef>();
  for (const r of targetTagRows) {
    if (typeof r.id !== "string" || typeof r.name !== "string") continue;
    const ref = { id: r.id, name: r.name };
    if (!targetTagsByName.has(r.name)) targetTagsByName.set(r.name, ref);
    const lower = r.name.toLowerCase();
    if (!targetTagsByName.has(lower)) targetTagsByName.set(lower, ref);
  }
  const targetMemberUserIds = new Set<string>();
  for (const r of memberRows) {
    if (typeof r.user_id === "string") targetMemberUserIds.add(r.user_id);
  }
  const copyName = uniqueCopyName(
    source.name,
    nameRows
      .map((r) => r.name)
      .filter((n): n is string => typeof n === "string"),
  );

  const ctx: RemapContext = { targetTagsByName, targetMemberUserIds, warnings: [] };
  const remapped = nodes.map((n) => ({
    node_key: n.node_key,
    node_type: n.node_type,
    config: remapNodeConfigForTarget(
      n.node_type,
      n.node_key,
      (n.config ?? {}) as Record<string, unknown>,
      sourceTagsById,
      ctx,
    ),
    position_x: n.position_x ?? 0,
    position_y: n.position_y ?? 0,
  }));

  // Insert the parent first (draft, fresh counters, target-owned).
  const inserted = await db
    .from("flows")
    .insert({
      account_id: targetAccountId,
      user_id: callerUserId,
      name: copyName,
      description: source.description,
      status: "draft",
      trigger_type: source.trigger_type,
      trigger_config: source.trigger_config ?? {},
      entry_node_id: source.entry_node_id,
      fallback_policy: source.fallback_policy ?? {},
      execution_count: 0,
      last_executed_at: null,
    })
    .select()
    .single();
  const copy = inserted.data as { id: string } | null;
  if (inserted.error || !copy) {
    throw new CopyFlowError(500, "Failed to create the target flow.");
  }

  // Re-own media objects, then insert nodes. Storage failures never
  // abort the copy: the source public URL keeps working (read-only),
  // flagged for the operator to re-upload.
  for (const n of remapped) {
    const cfg = n.config;
    for (const key of Object.keys(cfg)) {
      const value = cfg[key];
      if (!isMediaPlaceholder(value)) continue;
      const { bucket, path } = value.__copyMedia__;
      try {
        const fileName = path.split("/").pop() ?? "media";
        const toPath = buildMediaPath(targetAccountId, fileName);
        const { error: copyErr } = await db.storage.from(bucket).copy(path, toPath);
        if (copyErr) throw copyErr;
        cfg[key] = db.storage.from(bucket).getPublicUrl(toPath).data.publicUrl;
      } catch {
        const publicUrl = db.storage.from(bucket).getPublicUrl(path).data.publicUrl;
        cfg[key] = publicUrl;
        ctx.warnings.push({
          node_key: n.node_key,
          field: key,
          reason: `media object could not be re-owned (${path}) — still referencing the source account's file`,
        });
      }
    }
  }

  if (remapped.length > 0) {
    const { error: insErr } = (await db.from("flow_nodes").insert(
      remapped.map((n) => ({
        flow_id: copy.id,
        node_key: n.node_key,
        node_type: n.node_type,
        config: n.config,
        position_x: n.position_x,
        position_y: n.position_y,
      })),
    )) as unknown as { error: unknown };
    if (insErr) {
      // Compensating rollback: delete the parent; CASCADE removes any
      // partial nodes. No orphaned records survive a failed copy.
      await db.from("flows").delete().eq("id", copy.id);
      throw new CopyFlowError(500, "Failed to copy flow nodes — rolled back.");
    }
  }

  return {
    targetFlowId: copy.id,
    targetAccountId,
    flowName: copyName,
    nodeCount: remapped.length,
    warnings: ctx.warnings,
  };
}
