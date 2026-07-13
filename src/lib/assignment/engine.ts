import type { SupabaseClient } from "@supabase/supabase-js";
import { OFFLINE_AFTER_MS } from "@/lib/presence";

interface AssignmentConfig {
  account_id: string;
  default_mode: "round_robin" | "equal_load" | null;
  online_only: boolean;
  reassign_offline: boolean;
  round_robin_cursor: string | null;
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

async function getOnlineMembers(
  db: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString();
  const { data } = await db
    .from("member_presence")
    .select("user_id")
    .eq("account_id", accountId)
    .gte("last_seen_at", cutoff);

  return (data ?? []).map((r: { user_id: string }) => r.user_id);
}

async function getAllMembers(
  db: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  const { data } = await db
    .from("profiles")
    .select("user_id")
    .eq("account_id", accountId)
    .in("account_role", ["owner", "admin", "agent"]);

  return (data ?? []).map((r: { user_id: string }) => r.user_id);
}

async function applyDefaultMode(
  db: SupabaseClient,
  config: AssignmentConfig,
): Promise<string | null> {
  const candidates = config.online_only
    ? await getOnlineMembers(db, config.account_id)
    : await getAllMembers(db, config.account_id);

  if (candidates.length === 0) return null;

  if (config.default_mode === "round_robin") {
    return roundRobin(db, config, candidates);
  }

  if (config.default_mode === "equal_load") {
    return equalLoad(db, config.account_id, candidates);
  }

  return null;
}

async function roundRobin(
  db: SupabaseClient,
  config: AssignmentConfig,
  candidates: string[],
): Promise<string> {
  const sorted = [...candidates].sort();
  let nextIndex = 0;

  if (config.round_robin_cursor) {
    const cursorIdx = sorted.indexOf(config.round_robin_cursor);
    if (cursorIdx !== -1) {
      nextIndex = (cursorIdx + 1) % sorted.length;
    }
  }

  const chosen = sorted[nextIndex];

  await db
    .from("chat_assignment_config")
    .update({ round_robin_cursor: chosen })
    .eq("account_id", config.account_id);

  return chosen;
}

async function equalLoad(
  db: SupabaseClient,
  accountId: string,
  candidates: string[],
): Promise<string> {
  const { data: counts } = await db
    .from("conversations")
    .select("assigned_agent_id")
    .eq("account_id", accountId)
    .eq("status", "open")
    .in("assigned_agent_id", candidates);

  const loadMap = new Map<string, number>();
  for (const c of candidates) loadMap.set(c, 0);
  for (const row of counts ?? []) {
    if (row.assigned_agent_id) {
      loadMap.set(
        row.assigned_agent_id,
        (loadMap.get(row.assigned_agent_id) ?? 0) + 1,
      );
    }
  }

  let minAgent = candidates[0];
  let minCount = Infinity;
  for (const [agent, count] of loadMap) {
    if (count < minCount) {
      minCount = count;
      minAgent = agent;
    }
  }

  return minAgent;
}
