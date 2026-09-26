// ============================================================
// Travel CRM per-flow itinerary defaults.
//
// Workspace → Travel CRM Settings stores one itinerary list per
// (account, flow). Destination + City values are ALWAYS stable
// Travel CRM identifiers (the `value` from live lookup options),
// never invented display text. Nights is a positive integer.
//
// Lookup source of truth: the existing Travel CRM server-to-
// server lookups endpoint
//   GET {base}/api/integrations/wacrm/lookups
// fetched via fetchTravelCrmLookups (same auth as services).
// This module only PARSSES that payload — it never hardcodes
// destination or city values. Supported shapes (all optional,
// first usable wins, merged + deduped):
//   destinations: lookups.destinations | lookups.countries | ...
//   cities:       lookups.cities | nested `cities` on a
//                 destination | lookups.destinationCities map
// City → destination linkage is read from the city's parent
// fields (destination/country/parent + variants) or from
// nesting / mapping keys — never inferred from names.
// ============================================================

export interface TravelCrmItineraryDefault {
  /** Stable Travel CRM destination identifier (lookup `value`). */
  destination: string;
  /** Stable Travel CRM city identifier (lookup `value`). */
  city: string;
  /** Positive integer nights. */
  nights: number;
}

export interface TravelCrmDestinationOption {
  value: string;
  label: string;
}

export interface TravelCrmCityOption {
  value: string;
  label: string;
  /** Parent destination `value` when the lookup provides one. */
  destinationValue: string | null;
}

export const TRAVEL_CRM_MAX_ITINERARY_ROWS = 50;
export const TRAVEL_CRM_MAX_NIGHTS = 365;
export const TRAVEL_CRM_MAX_LOCATION_LENGTH = 120;

/** Lookup keys tried (in order) for destination options. */
const DESTINATION_LOOKUP_KEYS = [
  "destinations",
  "countries",
  "itineraryDestinations",
  "destinationList",
  "countryList",
] as const;

/** Lookup keys tried (in order) for city options. */
const CITY_LOOKUP_KEYS = [
  "cities",
  "itineraryCities",
  "cityList",
  "destinationCities",
  "countryCities",
] as const;

/** Fields on a city object that may point at its destination. */
const CITY_PARENT_FIELDS = [
  "destinationValue",
  "destination",
  "destinationId",
  "destination_id",
  "countryValue",
  "country",
  "countryId",
  "country_id",
  "parent",
  "parentValue",
  "parentId",
  "parent_id",
] as const;

/** Fields on a generic option object that may hold the value. */
const OPTION_VALUE_FIELDS = ["value", "id", "code", "key"] as const;

/** Fields on a generic option object that may hold the label. */
const OPTION_LABEL_FIELDS = ["label", "name", "title", "displayName"] as const;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readOptionValue(raw: Record<string, unknown>): string | null {
  for (const key of OPTION_VALUE_FIELDS) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function readOptionLabel(
  raw: Record<string, unknown>,
  fallback: string,
): string {
  for (const key of OPTION_LABEL_FIELDS) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return fallback;
}

function readParentValue(raw: Record<string, unknown>): string | null {
  for (const key of CITY_PARENT_FIELDS) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (Array.isArray(v)) {
      const first = v.find(
        (x): x is string => typeof x === "string" && x.trim().length > 0,
      );
      if (first) return first.trim();
    }
  }
  return null;
}

function pushUnique(
  list: TravelCrmDestinationOption[],
  seen: Set<string>,
  value: string,
  label: string,
): void {
  if (seen.has(value)) return;
  seen.add(value);
  list.push({ value, label: label || value });
}

function parseOptionList(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t) out.push({ value: t, label: t });
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      out.push(item as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Extract destination options from a live Travel CRM lookups
 * payload. Tries known keys in order and merges + dedupes by
 * stable `value`. Returns [] when nothing usable exists —
 * callers must render loading/error states, never fake values.
 */
export function extractDestinationOptions(
  lookups: Record<string, unknown> | null | undefined,
): TravelCrmDestinationOption[] {
  if (!lookups || typeof lookups !== "object") return [];
  const out: TravelCrmDestinationOption[] = [];
  const seen = new Set<string>();
  for (const key of DESTINATION_LOOKUP_KEYS) {
    for (const rec of parseOptionList(lookups[key])) {
      const value = readOptionValue(rec);
      if (!value) continue;
      pushUnique(out, seen, value, readOptionLabel(rec, value));
    }
  }
  return out;
}

/**
 * Extract city options (with parent destination linkage when the
 * lookup provides it) from a live Travel CRM lookups payload.
 * Handles flat lists, nested `cities` on destinations, and
 * `{destinationValue: [...]}` mapping objects. Returns [] when
 * nothing usable exists.
 */
export function extractCityOptions(
  lookups: Record<string, unknown> | null | undefined,
): TravelCrmCityOption[] {
  if (!lookups || typeof lookups !== "object") return [];
  const out: TravelCrmCityOption[] = [];
  const seen = new Set<string>();

  const pushCity = (value: string, label: string, parent: string | null) => {
    const key = `${parent ?? ""}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ value, label: label || value, destinationValue: parent });
  };

  // 1. Flat city lists.
  for (const key of CITY_LOOKUP_KEYS) {
    const raw = lookups[key];
    if (Array.isArray(raw)) {
      for (const rec of parseOptionList(raw)) {
        const value = readOptionValue(rec);
        if (!value) continue;
        pushCity(value, readOptionLabel(rec, value), readParentValue(rec));
      }
    } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      // 2. Mapping object: { <destinationValue>: [...] }.
      for (const [destKey, cityList] of Object.entries(
        raw as Record<string, unknown>,
      )) {
        const parent = destKey.trim() || null;
        for (const rec of parseOptionList(cityList)) {
          const value = readOptionValue(rec);
          if (!value) continue;
          pushCity(
            value,
            readOptionLabel(rec, value),
            readParentValue(rec) ?? parent,
          );
        }
      }
    }
  }

  // 3. Nested `cities` on destination objects (any destination key).
  for (const key of DESTINATION_LOOKUP_KEYS) {
    for (const rec of parseOptionList(lookups[key])) {
      const destValue = readOptionValue(rec);
      if (!destValue) continue;
      const nested = (rec as Record<string, unknown>).cities;
      for (const cityRec of parseOptionList(nested)) {
        const value = readOptionValue(cityRec);
        if (!value) continue;
        pushCity(
          value,
          readOptionLabel(cityRec, value),
          readParentValue(cityRec) ?? destValue,
        );
      }
    }
  }

  return out;
}

export interface TravelCrmItineraryLookups {
  destinations: TravelCrmDestinationOption[];
  cities: TravelCrmCityOption[];
  /** Cities grouped by parent destination `value`. */
  citiesByDestination: Record<string, TravelCrmDestinationOption[]>;
}

/**
 * Build the full itinerary lookup view from a live Travel CRM
 * lookups payload. Pure + deterministic. Never hardcodes values.
 */
export function buildItineraryLookups(
  lookups: Record<string, unknown> | null | undefined,
): TravelCrmItineraryLookups {
  const destinations = extractDestinationOptions(lookups);
  const cities = extractCityOptions(lookups);
  const citiesByDestination: Record<string, TravelCrmDestinationOption[]> = {};
  for (const c of cities) {
    if (!c.destinationValue) continue;
    const list = (citiesByDestination[c.destinationValue] ??= []);
    if (!list.some((o) => o.value === c.value)) {
      list.push({ value: c.value, label: c.label });
    }
  }
  return { destinations, cities, citiesByDestination };
}

/**
 * Cities valid for one destination. When the lookup provides no
 * parent linkage at all (all destinationValue null), every city
 * is returned — the dialog still lets the agent pick, and Travel
 * CRM validates authoritatively. Otherwise only linked cities.
 */
export function citiesForDestination(
  cities: ReadonlyArray<{
    value: string;
    label: string;
    destinationValue?: string | null;
  }>,
  destinationValue: string,
): Array<{ value: string; label: string; destinationValue: string | null }> {
  const normalized = cities.map((c) => ({
    value: c.value,
    label: (c as { label?: unknown }).label as string,
    destinationValue: c.destinationValue ?? null,
  }));
  const linked = normalized.filter((c) => c.destinationValue !== null);
  if (linked.length === 0) return [...normalized];
  return normalized.filter((c) => c.destinationValue === destinationValue);
}

/**
 * True when `cityValue` may be kept for `destinationValue`:
 * either the lookup links it to that destination, or the lookup
 * provides no linkage at all (free pairing, server validates).
 */
export function isCompatibleCity(
  cities: ReadonlyArray<{
    value: string;
    destinationValue?: string | null;
  }>,
  destinationValue: string,
  cityValue: string,
): boolean {
  const linked = cities.filter((c) => (c.destinationValue ?? null) !== null);
  if (linked.length === 0) return true;
  return linked.some(
    (c) => c.value === cityValue && (c.destinationValue ?? null) === destinationValue,
  );
}

/** Validate a nights input (string from UI or number). */
export function validateNightsInput(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1) {
      return "Nights must be a positive whole number.";
    }
    if (value > TRAVEL_CRM_MAX_NIGHTS) {
      return `Nights must be at most ${TRAVEL_CRM_MAX_NIGHTS}.`;
    }
    return null;
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "Nights is required.";
  if (!/^\d+$/.test(text)) return "Nights must be a positive whole number.";
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) {
    return "Nights must be a positive whole number.";
  }
  if (n > TRAVEL_CRM_MAX_NIGHTS) {
    return `Nights must be at most ${TRAVEL_CRM_MAX_NIGHTS}.`;
  }
  return null;
}

function toNights(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/**
 * Validate + normalize itinerary defaults for storage. Drops
 * empty rows (no destination, no city, no nights); throws with a
 * human-readable message on structurally invalid input or on a
 * non-empty row with an invalid nights value. Preserves order,
 * keeps stable Travel CRM identifiers verbatim.
 */
export function normalizeItineraryDefaults(
  value: unknown,
): TravelCrmItineraryDefault[] {
  if (!Array.isArray(value)) {
    throw new Error("Itinerary must be a list.");
  }
  if (value.length > TRAVEL_CRM_MAX_ITINERARY_ROWS) {
    throw new Error(
      `Itinerary must have at most ${TRAVEL_CRM_MAX_ITINERARY_ROWS} rows.`,
    );
  }
  const out: TravelCrmItineraryDefault[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Each itinerary row must be an object.");
    }
    const rec = raw as Record<string, unknown>;
    const destination = asNonEmptyString(rec.destination);
    const city = asNonEmptyString(rec.city);
    const nightsRaw =
      rec.nights === undefined || rec.nights === null
        ? ""
        : (rec.nights as unknown);
    const nightsText =
      typeof nightsRaw === "string" ? nightsRaw.trim() : nightsRaw;

    const isEmptyRow =
      !destination &&
      !city &&
      (nightsText === "" ||
        nightsText === null ||
        nightsText === undefined);
    if (isEmptyRow) continue;

    if (!destination || !city) continue;

    if (
      destination.length > TRAVEL_CRM_MAX_LOCATION_LENGTH ||
      city.length > TRAVEL_CRM_MAX_LOCATION_LENGTH
    ) {
      throw new Error("Destination or city name is too long.");
    }
    const nights = toNights(nightsRaw);
    const nightsError = validateNightsInput(
      typeof nightsRaw === "number" ? nightsRaw : String(nightsRaw ?? ""),
    );
    if (nights === null || nightsError) {
      throw new Error(
        nightsError ?? "Nights must be a positive whole number.",
      );
    }
    out.push({ destination, city, nights });
  }
  return out;
}

/** Stored defaults → Travel CRM draft rows ({country, destination, nights}). */
export function defaultsToDraftItinerary(
  defaults: readonly TravelCrmItineraryDefault[],
): Array<{ country: string; destination: string; nights: number }> {
  return defaults.map((d) => ({
    country: d.destination,
    destination: d.city,
    nights: d.nights,
  }));
}

/** Draft/prefill rows → stored defaults shape (drops incomplete). */
export function draftToItineraryDefaults(
  rows: ReadonlyArray<{
    country?: unknown;
    destination?: unknown;
    city?: unknown;
    nights?: unknown;
  }>,
): TravelCrmItineraryDefault[] {
  const out: TravelCrmItineraryDefault[] = [];
  for (const r of rows) {
    const dest =
      asNonEmptyString(r.destination) ?? asNonEmptyString(r.city) ?? null;
    // Draft shape uses {country, destination}; prefill shape uses
    // {destination, city}. Accept both without guessing.
    const countryFirst = asNonEmptyString(
      (r as Record<string, unknown>).country,
    );
    const destinationField = asNonEmptyString(
      (r as Record<string, unknown>).destination,
    );
    const cityField = asNonEmptyString((r as Record<string, unknown>).city);
    const resolvedDestination = countryFirst ?? destinationField ?? dest;
    // When the row came from draft ({country, destination}), the
    // city is `destination` and the destination is `country`.
    const finalDestination =
      countryFirst !== null ? countryFirst : resolvedDestination;
    const finalCity =
      countryFirst !== null
        ? (destinationField ?? cityField)
        : (cityField ?? null);
    if (!finalDestination || !finalCity) continue;
    const nights = toNights(r.nights);
    if (nights === null || validateNightsInput(nights) !== null) continue;
    out.push({
      destination: finalDestination,
      city: finalCity,
      nights,
    });
  }
  return out;
}
