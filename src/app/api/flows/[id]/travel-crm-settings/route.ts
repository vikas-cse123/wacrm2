import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  isOfferedServiceLabel,
  normalizeServiceLabels,
} from "@/lib/integrations/travel-crm/services";
import {
  normalizeItineraryDefaults,
  type TravelCrmItineraryDefault,
} from "@/lib/integrations/travel-crm/itineraries";
import {
  normalizeDepartureDefaults,
  validateDepartureCatalog,
  type TravelCrmDepartureDefaults,
} from "@/lib/integrations/travel-crm/departures";

export const dynamic = "force-dynamic";

/**
 * Per-flow Travel CRM defaults for Workspace lead creation.
 *
 * GET  — any account member; `{ services: string[], itinerary:
 *        TravelCrmItineraryDefault[], departure:
 *        TravelCrmDepartureDefaults | null }` (empty/null when the
 *        flow has no saved configuration — never invented).
 * PUT  — agent+; replaces the flow's services with labels from
 *        the offered set AND (when the `itinerary` / `departure`
 *        keys are present) replaces those defaults. Unknown service
 *        labels are rejected, never stored. Empty/invalid itinerary
 *        rows are dropped; invalid nights reject the save.
 *        Departure defaults are validated against the COPIED Travel
 *        CRM catalog (world-countries names, INDIAN cities, curated
 *        cities — no Travel CRM call): unknown country, unknown
 *        city, or a city outside the country rejects the save;
 *        `null`/empty clears them. Omitting `itinerary`/`departure`
 *        preserves the stored values (backward compatible with
 *        services-only clients); `[]`/`null` clears them.
 *
 * The flow must belong to the caller's account — ids from the
 * browser are never trusted as authority. Saving here never
 * touches any lead; it only changes future defaults.
 */

async function loadFlowAccount(
  supabase: SupabaseClient,
  accountId: string,
  flowId: string,
) {
  const { data: flow, error } = await supabase
    .from("flows")
    .select("id, account_id")
    .eq("id", flowId)
    .maybeSingle();
  if (error) throw error;
  if (!flow || (flow as { account_id: string }).account_id !== accountId) {
    return null;
  }
  return flow;
}

function toServices(row: Record<string, unknown> | null): string[] {
  if (!row || !Array.isArray(row.services)) return [];
  return (row.services as unknown[]).filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
}

function toItinerary(row: Record<string, unknown> | null): TravelCrmItineraryDefault[] {
  if (!row || row.itinerary === undefined || row.itinerary === null) return [];
  try {
    return normalizeItineraryDefaults(row.itinerary);
  } catch {
    return [];
  }
}

function toDeparture(row: Record<string, unknown> | null): TravelCrmDepartureDefaults | null {
  if (!row) return null;
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
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await getCurrentAccount();
    if (!(await loadFlowAccount(supabase, accountId, id))) {
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    const { data, error } = await supabase
      .from("travel_crm_flow_settings")
      .select("services, itinerary, departure_country, departure_city")
      .eq("account_id", accountId)
      .eq("flow_id", id)
      .maybeSingle();
    if (error) throw error;
    const row = data as Record<string, unknown> | null;
    return NextResponse.json({
      services: toServices(row),
      itinerary: toItinerary(row),
      departure: toDeparture(row),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await requireRole("agent");
    if (!(await loadFlowAccount(supabase, accountId, id))) {
      return NextResponse.json({ error: "Flow not found." }, { status: 404 });
    }
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    let services: string[];
    try {
      services = normalizeServiceLabels(body.services);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Invalid services." },
        { status: 400 },
      );
    }
    const unknown = services.filter((s) => !isOfferedServiceLabel(s));
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: `Unknown service: ${unknown.join(", ")}.` },
        { status: 400 },
      );
    }
    // Itinerary is optional for backward compatibility: absent →
    // preserve the stored list; present (even []) → validate +
    // replace. Empty/invalid rows are dropped by the normalizer;
    // invalid nights reject the save.
    let itinerary: TravelCrmItineraryDefault[] | null = null;
    if ("itinerary" in body) {
      try {
        itinerary = normalizeItineraryDefaults(body.itinerary);
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Invalid itinerary." },
          { status: 400 },
        );
      }
    } else {
      try {
        const { data: existing } = await supabase
          .from("travel_crm_flow_settings")
          .select("itinerary")
          .eq("account_id", accountId)
          .eq("flow_id", id)
          .maybeSingle();
        itinerary = toItinerary(existing as Record<string, unknown> | null);
      } catch {
        itinerary = [];
      }
    }
    // Departure is optional for backward compatibility: absent →
    // preserve the stored defaults; present (object or null) →
    // normalize + validate against the COPIED Travel CRM catalog
    // and replace. Null/empty clears. A city without a country, an
    // unknown country/city, or a city outside the country rejects
    // the save. No Travel CRM call is made here.
    let departure: TravelCrmDepartureDefaults | null = null;
    let preserveDeparture = true;
    if ("departure" in body) {
      preserveDeparture = false;
      try {
        departure = normalizeDepartureDefaults(body.departure);
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Invalid departure defaults." },
          { status: 400 },
        );
      }
      if (departure !== null) {
        try {
          validateDepartureCatalog(departure);
        } catch (err) {
          return NextResponse.json(
            { error: err instanceof Error ? err.message : "Invalid departure defaults." },
            { status: 400 },
          );
        }
      }
    }
    if (preserveDeparture) {
      try {
        const { data: existing } = await supabase
          .from("travel_crm_flow_settings")
          .select("departure_country, departure_city")
          .eq("account_id", accountId)
          .eq("flow_id", id)
          .maybeSingle();
        departure = toDeparture(existing as Record<string, unknown> | null);
      } catch {
        departure = null;
      }
    }
    const { data, error } = await supabase
      .from("travel_crm_flow_settings")
      .upsert(
        {
          account_id: accountId,
          flow_id: id,
          services,
          itinerary: itinerary ?? [],
          departure_country: departure?.country ?? null,
          departure_city: departure?.city ?? null,
        },
        { onConflict: "account_id,flow_id" },
      )
      .select("services, itinerary, departure_country, departure_city")
      .single();
    if (error) throw error;
    const row = data as Record<string, unknown> | null;
    return NextResponse.json({
      services: toServices(row),
      itinerary: toItinerary(row),
      departure: toDeparture(row),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
