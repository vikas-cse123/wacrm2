import type { SupabaseClient } from "@supabase/supabase-js";
import { OFFLINE_AFTER_MS } from "@/lib/presence";

interface AssignmentConfig {
  account_id: string;
  default_mode: "round_robin" | "equal_load" | null;
  online_only: boolean;
  reassign_offline: boolean;
}

interface AssignmentRule {
  id: string;
  trait_field: string;
  condition: "is" | "contains" | "starts_with";
  trait_values: string[];
  agent_ids: string[];
  is_active: boolean;
}

interface ContactTraits {
  [key: string]: string | null | undefined;
}

interface ResolveOpts {
  /**
   * The agent currently assigned to this conversation, if any. When set,
   * the engine only returns a *new* agent if `reassign_offline` is on and
   * that agent has gone offline — otherwise it returns null (keep as-is).
   */
  currentAgentId?: string | null;
}

/**
 * Decide which agent an inbound conversation should belong to.
 *
 * Returns the chosen agent's user_id, or null when nothing should change
 * (no config, no eligible agent, or an already-assigned conversation that
 * doesn't qualify for reassignment).
 */
export async function resolveAssignment(
  db: SupabaseClient,
  accountId: string,
  contactTraits: ContactTraits,
  opts: ResolveOpts = {},
): Promise<string | null> {
  const currentAgentId = opts.currentAgentId ?? null;

  const { data: config } = await db
    .from("chat_assignment_config")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();

  if (!config || !config.default_mode) return null;

  // Already assigned. Leave it alone unless reassign-on-offline is enabled
  // and the current owner has actually gone offline.
  if (currentAgentId) {
    if (!config.reassign_offline) return null;
    if (await isAgentOnline(db, accountId, currentAgentId)) return null;
    // else fall through and pick a replacement (an online agent).
  }

  // When reassigning we always want an online replacement (moving off an
  // offline agent onto an offline one would be pointless).
  const requireOnline = config.online_only || currentAgentId !== null;

  const assignable = await getAssignableMembers(db, accountId);
  const assignableSet = new Set(assignable);

  // Custom rules take priority over the default mode.
  const { data: rules } = await db
    .from("chat_assignment_rules")
    .select("*")
    .eq("account_id", accountId)
    .eq("is_active", true)
    .order("position", { ascending: true });

  if (rules && rules.length > 0) {
    for (const rule of rules as AssignmentRule[]) {
      if (!matchesRule(rule, contactTraits)) continue;

      // Only agents who are still valid members, and never the agent we're
      // reassigning away from.
      let pool = rule.agent_ids.filter(
        (id) => assignableSet.has(id) && id !== currentAgentId,
      );
      if (requireOnline) pool = await filterOnline(db, accountId, pool);

      // Balance the rule's chats across its agents instead of always
      // picking the first one.
      if (pool.length > 0) return equalLoad(db, accountId, pool);
    }
  }

  // Default mode.
  let candidates = requireOnline
    ? await filterOnline(db, accountId, assignable)
    : assignable;
  if (currentAgentId) candidates = candidates.filter((id) => id !== currentAgentId);
  if (candidates.length === 0) return null;

  if (config.default_mode === "round_robin") {
    return roundRobin(db, accountId, candidates);
  }
  if (config.default_mode === "equal_load") {
    return equalLoad(db, accountId, candidates);
  }
  return null;
}

function matchesRule(rule: AssignmentRule, traits: ContactTraits): boolean {
  const value = traits[rule.trait_field];
  if (value == null) return false;
  const lower = value.toLowerCase();

  return rule.trait_values.some((tv) => {
    const tvLower = tv.toLowerCase();
    switch (rule.condition) {
      case "is":
        return lower === tvLower;
      case "contains":
        return lower.includes(tvLower);
      case "starts_with":
        return lower.startsWith(tvLower);
      default:
        return false;
    }
  });
}

/** Members who can be assigned chats — admins and agents (never owner/viewer). */
async function getAssignableMembers(
  db: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  const { data } = await db
    .from("profiles")
    .select("user_id")
    .eq("account_id", accountId)
    .in("account_role", ["admin", "agent"]);

  return (data ?? []).map((r: { user_id: string }) => r.user_id);
}

/** Narrow a set of user ids to just those currently online (recent heartbeat). */
async function filterOnline(
  db: SupabaseClient,
  accountId: string,
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];

  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString();
  const { data } = await db
    .from("member_presence")
    .select("user_id")
    .eq("account_id", accountId)
    .in("user_id", userIds)
    .gte("last_seen_at", cutoff);

  return (data ?? []).map((r: { user_id: string }) => r.user_id);
}

/** True when the member has heartbeated within the offline window. */
async function isAgentOnline(
  db: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString();
  const { data } = await db
    .from("member_presence")
    .select("user_id")
    .eq("account_id", accountId)
    .eq("user_id", userId)
    .gte("last_seen_at", cutoff)
    .maybeSingle();

  return !!data;
}

async function roundRobin(
  db: SupabaseClient,
  accountId: string,
  candidates: string[],
): Promise<string> {
  const sorted = [...candidates].sort();

  const { count } = await db
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .not("assigned_agent_id", "is", null);

  const index = (count ?? 0) % sorted.length;
  return sorted[index];
}

async function equalLoad(
  db: SupabaseClient,
  accountId: string,
  candidates: string[],
): Promise<string> {
  // "Load" = every conversation currently on an agent's plate, i.e. any
  // status except 'closed'. Counting only 'open' hid pending chats and
  // made agents look under-loaded, skewing the balance.
  const { data: convs } = await db
    .from("conversations")
    .select("assigned_agent_id")
    .eq("account_id", accountId)
    .neq("status", "closed")
    .in("assigned_agent_id", candidates);

  const loadMap = new Map<string, number>();
  for (const c of candidates) loadMap.set(c, 0);
  for (const row of convs ?? []) {
    if (row.assigned_agent_id) {
      loadMap.set(
        row.assigned_agent_id,
        (loadMap.get(row.assigned_agent_id) ?? 0) + 1,
      );
    }
  }

  // Sort candidates so ties resolve deterministically (lowest id first),
  // matching round-robin's stable ordering.
  const sorted = [...candidates].sort();
  let minAgent = sorted[0];
  let minCount = Infinity;
  for (const agent of sorted) {
    const count = loadMap.get(agent) ?? 0;
    if (count < minCount) {
      minCount = count;
      minAgent = agent;
    }
  }

  return minAgent;
}
