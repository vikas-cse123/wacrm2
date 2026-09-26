import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeItineraryDefaults,
  type TravelCrmItineraryDefault,
} from "./itineraries";
import type { TravelCrmDepartureDefaults } from "./departures";

// ============================================================
// Travel CRM per-flow service + itinerary defaults (read side).
//
// Stored in travel_crm_flow_settings (one row per account +
// flow); see supabase/migrations/101_travel_crm_flow_settings.sql
// (services) and 102_travel_crm_itinerary_defaults.sql
// (itinerary). Writes live in the flow settings API route — this
// module only reads, so lead creation stays side-effect free
// until the send.
// ============================================================

/**
 * Load a flow's saved Travel CRM service labels. Returns [] when
 * the flow has no configuration — callers must not invent
 * services in that case.
 */
export async function readFlowServiceLabels(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from("travel_crm_flow_settings")
      .select("services")
      .eq("account_id", accountId)
      .eq("flow_id", flowId)
      .maybeSingle();
    if (error || !data) return [];
    const services = (data as { services?: unknown }).services;
    if (!Array.isArray(services)) return [];
    return services.filter(
      (s): s is string => typeof s === "string" && s.trim().length > 0,
    );
  } catch {
    // A missing table or read failure degrades to "no defaults" —
    // the dialog path still works, Travel CRM validates on send.
    return [];
  }
}

/**
 * Load a flow's saved Travel CRM itinerary defaults. Returns []
 * when the flow has no configuration — callers must not invent
 * an itinerary in that case. Rows keep stable Travel CRM
 * identifiers verbatim; invalid stored rows are dropped, never
 * guessed.
 */
export async function readFlowItineraryDefaults(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<TravelCrmItineraryDefault[]> {
  try {
    const { data, error } = await supabase
      .from("travel_crm_flow_settings")
      .select("itinerary")
      .eq("account_id", accountId)
      .eq("flow_id", flowId)
      .maybeSingle();
    if (error || !data) return [];
    const raw = (data as { itinerary?: unknown }).itinerary;
    if (raw === undefined || raw === null) return [];
    try {
      return normalizeItineraryDefaults(raw);
    } catch {
      return [];
    }
  } catch {
    // A missing column/table or read failure degrades to "no
    // defaults" — the dialog path still works, Travel CRM
    // validates on send.
    return [];
  }
}

/**
 * Load a flow's saved Travel CRM departure defaults. Returns null
 * when the flow has no configuration — callers must not invent
 * values in that case (the dialog stays empty). Identifiers are
 * returned verbatim; a missing column/table or read failure also
 * degrades to null so the dialog path keeps working.
 */
export async function readFlowDepartureDefaults(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
): Promise<TravelCrmDepartureDefaults | null> {
  try {
    const { data, error } = await supabase
      .from("travel_crm_flow_settings")
      .select("departure_country, departure_city")
      .eq("account_id", accountId)
      .eq("flow_id", flowId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { departure_country?: unknown; departure_city?: unknown };
    const country =
      typeof row.departure_country === "string" && row.departure_country.trim()
        ? row.departure_country.trim()
        : null;
    if (country === null) return null;
    const city =
      typeof row.departure_city === "string" && row.departure_city.trim()
        ? row.departure_city.trim()
        : null;
    return { country, city };
  } catch {
    return null;
  }
}
