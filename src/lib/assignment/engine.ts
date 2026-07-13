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

export async function resolveAssignment(
  db: SupabaseClient,
  accountId: string,
  contactTraits: ContactTraits,
): Promise<string | null> {
  const { data: config } = await db
    .from("chat_assignment_config")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();

  if (!config || !config.default_mode) return null;

  const { data: rules } = await db
    .from("chat_assignment_rules")
    .select("*")
    .eq("account_id", accountId)
    .eq("is_active", true)
    .order("position", { ascending: true });

  if (rules && rules.length > 0) {
    for (const rule of rules as AssignmentRule[]) {
      if (matchesRule(rule, contactTraits)) {
        const eligible = await filterOnlineAgents(
          db,
          accountId,
          rule.agent_ids,
          config.online_only,
        );
        if (eligible.length > 0) return eligible[0];
      }
    }
  }

  return applyDefaultMode(db, config as AssignmentConfig);
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

async function filterOnlineAgents(
  db: SupabaseClient,
  accountId: string,
  agentIds: string[],
  onlineOnly: boolean,
): Promise<string[]> {
  if (!onlineOnly || agentIds.length === 0) return agentIds;

  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString();
  const { data } = await db
    .from("member_presence")
    .select("user_id")
    .eq("account_id", accountId)
    .in("user_id", agentIds)
    .gte("last_seen_at", cutoff);

  return (data ?? []).map((r: { user_id: string }) => r.user_id);
}

async function getOnlineAgents(
  db: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  const assignable = await getAssignableMembers(db, accountId);
  if (assignable.length === 0) return [];

  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString();
  const { data } = await db
    .from("member_presence")
    .select("user_id")
    .eq("account_id", accountId)
    .in("user_id", assignable)
    .gte("last_seen_at", cutoff);

  return (data ?? []).map((r: { user_id: string }) => r.user_id);
}

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

async function applyDefaultMode(
  db: SupabaseClient,
  config: AssignmentConfig,
): Promise<string | null> {
  const candidates = config.online_only
    ? await getOnlineAgents(db, config.account_id)
    : await getAssignableMembers(db, config.account_id);

  if (candidates.length === 0) return null;

  if (config.default_mode === "round_robin") {
    return roundRobin(db, config.account_id, candidates);
  }

  if (config.default_mode === "equal_load") {
    return equalLoad(db, config.account_id, candidates);
  }

  return null;
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
