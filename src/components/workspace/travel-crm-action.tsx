"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Plane, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TRAVEL_CRM_SERVICE_LABELS,
  joinServiceLabels,
  splitServiceLabels,
} from "@/lib/integrations/travel-crm/services";
import {
  citiesForDestination,
  validateNightsInput,
} from "@/lib/integrations/travel-crm/itineraries";
import {
  displayToCanonicalPhone,
  formatPhoneForDisplay,
  isIndianCountryCodeNumber,
} from "@/lib/whatsapp/phone-utils";
import {
  LEAD_RECEIVED_FIELD_NAME,
  LEAD_RECEIVED_OPTIONS,
  LEAD_TYPE_FIELD_NAME,
  LEAD_TYPE_OPTIONS,
  STAGE_FIELD_NAME,
  STAGE_OPTIONS,
} from "@/lib/flows/workspace-defaults";
import {
  DEPARTURE_COUNTRIES,
  departureCityOptions,
  isDepartureCityInCountry,
} from "@/lib/integrations/travel-crm/departure-catalog";
import { getSelectChip } from "@/lib/flows/workspace-select-chips";
import {
  filterCellOptions,
  OPTION_SEARCH_THRESHOLD,
  OptionSearchBox,
  SELECT_CELL_TRIGGER_CLASS,
  SelectChipView,
} from "./custom-cell";

interface MappingPayload {
  available: string[];
  missing: string[];
  ambiguous: Array<{ field: string; candidates: string[] }>;
  invalid: Array<{ field: string; reason: string }>;
  ready: boolean;
}

interface LookupOption {
  value: string;
  label: string;
  destinationValue?: string | null;
}

interface PrepareResult {
  success: boolean;
  code: string;
  error?: string;
  fields?: Record<string, string[]>;
  leadId?: string;
  leadUrl?: string;
  alreadyExists?: boolean;
  mapping?: MappingPayload;
  prefill?: Record<string, unknown>;
  options?: Record<string, LookupOption[] | null> | null;
  receivedOptions?: LookupOption[] | null;
  destinations?: LookupOption[] | null;
  cities?: LookupOption[] | null;
  citiesByDestination?: Record<string, LookupOption[]> | null;
  assignedOwnerEmail?: string | null;
  assignmentIssue?: string | null;
  workspaceSync?: {
    updated: string[];
    failed: Array<{ field: string; error: string }>;
    rowPatch: {
      answers: Record<string, string | null>;
      name: string | null;
      phone: string | null;
    };
  };
}

/** Workspace row patch applied after a synced create (table + drawer). */
export interface WorkspaceRowPatch {
  answers: Record<string, string | null>;
  name: string | null;
  phone: string | null;
  /** Custom-field cell values by workspace field id (Type/Stage/Received). */
  customValues: Record<string, string | null>;
}

interface TeamMember {
  user_id: string;
  full_name: string | null;
  email?: string | null;
}

export interface DialogInput {
  field: string;
  label: string;
  kind: "member" | "date" | "text" | "number" | "select" | "multi" | "itinerary" | "travelers";
  value: unknown;
  options?: LookupOption[] | null;
  cities?: LookupOption[] | null;
  citiesByDestination?: Record<string, LookupOption[]> | null;
  hint?: string;
}

/**
 * Editable traveler counts + per-child ages for the Travelers
 * section. Counts stay strings while typing (validated on
 * submit); each age row is one optional string entry.
 */
export interface TravelerForm {
  adults: string;
  cwb: string;
  cwob: string;
  infants: string;
  cwbAges: string[];
  cwobAges: string[];
  infantAges: string[];
}

/** Maximum age accepted per optional age entry. */
export const MAX_TRAVELER_AGE = 99;

function prefillCount(value: unknown, fallback: string): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : fallback;
}

function prefillAges(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .map(String);
}

/**
 * Seed the Travelers section from prefill (stable values echoed
 * by the server, including the agent's own entries on dialog
 * re-rounds). Adults falls back to "1" — Travel CRM requires at
 * least one adult — while children/infants stay empty (optional)
 * and ages start blank.
 */
export function seedTravelerForm(prefill: Record<string, unknown>): TravelerForm {
  return {
    adults: prefillCount(prefill.adults, "1"),
    cwb: prefillCount(prefill.childrenWithBed, ""),
    cwob: prefillCount(prefill.childrenWithoutBed, ""),
    infants: prefillCount(prefill.infants, ""),
    cwbAges: prefillAges(prefill.childrenWithBedAges),
    cwobAges: prefillAges(prefill.childrenWithoutBedAges),
    infantAges: prefillAges(prefill.infantAges),
  };
}

/** Parse a non-negative count input; NaN when blank/invalid. */
export function travelerAgeCount(countText: string): number {
  if (!/^\d+$/.test(countText.trim())) return 0;
  const n = Number(countText.trim());
  return Number.isSafeInteger(n) ? n : 0;
}

/**
 * Resize age rows to a count: shrinking drops the extra rows
 * (their values are discarded safely), growing pads blanks.
 * Never mutates the input.
 */
export function resizeAgeRows(ages: string[], count: number): string[] {
  const next = ages.slice(0, Math.max(0, count));
  while (next.length < Math.max(0, count)) next.push("");
  return next;
}

function isWholeNumber(text: string): boolean {
  return /^\d+$/.test(text.trim());
}

/**
 * Validate the Travelers section before Create. Returns a
 * human-readable message or null when valid. Adults is required
 * (integer ≥ 1, never empty/0/negative); children/infants are
 * optional (empty omitted, otherwise integer ≥ 0); ages are
 * optional (blank entries skipped, the rest integers 0–99), so a
 * blank optional age never blocks creation.
 */
export function validateTravelerForm(form: TravelerForm): string | null {
  const adults = form.adults.trim();
  if (!adults) return "Adults is required.";
  if (!isWholeNumber(adults)) return "Adults must be a whole number.";
  if (Number(adults) < 1) return "Adults must be at least 1.";
  for (const [label, raw] of [
    ["CWB", form.cwb],
    ["CWOB", form.cwob],
    ["Infants", form.infants],
  ] as const) {
    const text = raw.trim();
    if (!text) continue;
    // ^\d+$ admits only non-negative integers, so empties are the
    // only other shape — both mean "not provided".
    if (!isWholeNumber(text)) return `${label} must be a whole number.`;
  }
  const ageGroups: ReadonlyArray<{ label: string; ages: string[] }> = [
    { label: "CWB ages", ages: form.cwbAges },
    { label: "CWOB ages", ages: form.cwobAges },
    { label: "Infant ages", ages: form.infantAges },
  ];
  for (const { label, ages } of ageGroups) {
    for (const raw of ages) {
      const text = raw.trim();
      if (!text) continue;
      if (!isWholeNumber(text)) return `${label} must be whole numbers.`;
      const n = Number(text);
      if (n < 0 || n > MAX_TRAVELER_AGE) {
        return `${label} must be between 0 and ${MAX_TRAVELER_AGE}.`;
      }
    }
  }
  return null;
}

export interface TravelerOverrides {
  adults: number;
  childrenWithBed: number | null;
  childrenWithoutBed: number | null;
  infants: number | null;
  childrenWithBedAges: number[];
  childrenWithoutBedAges: number[];
  infantAges: number[];
}

/**
 * Validated traveler form → lead-creation overrides. Call only
 * after validateTravelerForm returns null. Empty optionals become
 * null (counts) or [] (ages); Adults is always present (≥ 1).
 */
export function travelerFormToOverrides(form: TravelerForm): TravelerOverrides {
  const countOrNull = (raw: string): number | null => {
    const text = raw.trim();
    return text === "" ? null : Number(text);
  };
  const agesOf = (ages: string[]): number[] =>
    ages.map((a) => a.trim()).filter((a) => a !== "").map(Number);
  return {
    adults: Number(form.adults.trim()),
    childrenWithBed: countOrNull(form.cwb),
    childrenWithoutBed: countOrNull(form.cwob),
    infants: countOrNull(form.infants),
    childrenWithBedAges: agesOf(form.cwbAges),
    childrenWithoutBedAges: agesOf(form.cwobAges),
    infantAges: agesOf(form.infantAges),
  };
}

export interface ItineraryDialogRow {
  destination: string;
  city: string;
  nights: string;
}

/** Blank dialog itinerary row (nights as text for typing). */
export function createEmptyItineraryDialogRow(): ItineraryDialogRow {
  return { destination: "", city: "", nights: "" };
}

/** Pure: append a blank row (Add More). Never mutates input. */
export function addItineraryDialogRow(
  rows: ItineraryDialogRow[],
): ItineraryDialogRow[] {
  return [...rows, createEmptyItineraryDialogRow()];
}

/** Pure: remove one row (Remove). Allows empty overall. Never mutates. */
export function removeItineraryDialogRow(
  rows: ItineraryDialogRow[],
  index: number,
): ItineraryDialogRow[] {
  return rows.filter((_, i) => i !== index);
}

/**
 * Pure: set a dialog row's destination, clearing an incompatible
 * city rather than keeping an invalid pairing. Never mutates.
 */
export function updateItineraryDialogDestination(
  rows: ItineraryDialogRow[],
  index: number,
  destination: string,
  cities: ReadonlyArray<{ value: string; destinationValue?: string | null }>,
): ItineraryDialogRow[] {
  return rows.map((row, i) => {
    if (i !== index) return row;
    const next = { ...row, destination };
    if (!next.city) return next;
    const linked = cities.filter((c) => c.destinationValue != null);
    if (linked.length === 0) return next;
    const compatible = linked.some(
      (c) => c.value === next.city && c.destinationValue === destination,
    );
    return compatible ? next : { ...next, city: "" };
  });
}

/**
 * Seed dialog itinerary rows from prefill (stable Travel CRM IDs
 * preserved verbatim). Returns [] when nothing prefilled — the
 * dialog shows an empty itinerary, never an invented one.
 */
export function seedItineraryDialogRows(
  prefill: Record<string, unknown>,
): ItineraryDialogRow[] {
  const raw = prefill.itinerary;
  if (!Array.isArray(raw)) return [];
  const out: ItineraryDialogRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const destination =
      typeof rec.destination === "string" ? rec.destination : "";
    const city = typeof rec.city === "string" ? rec.city : "";
    const nights =
      typeof rec.nights === "number" && Number.isFinite(rec.nights)
        ? String(rec.nights)
        : typeof rec.nights === "string"
          ? rec.nights
          : "";
    if (!destination && !city && !nights.trim()) continue;
    out.push({ destination, city, nights });
  }
  return out;
}

/**
 * Dialog rows → lead-creation overrides payload. Drops empty rows;
 * throws with a human-readable message on invalid nights so the
 * dialog can surface it without sending.
 */
export function itineraryDialogRowsToOverrides(
  rows: ItineraryDialogRow[],
): Array<{ destination: string; city: string; nights: number }> {
  const out: Array<{ destination: string; city: string; nights: number }> = [];
  for (const row of rows) {
    if (!row.destination && !row.city && !row.nights.trim()) continue;
    if (!row.destination || !row.city) continue;
    const err = validateNightsInput(row.nights);
    if (err) throw new Error(err);
    out.push({
      destination: row.destination,
      city: row.city,
      nights: Number(row.nights.trim()),
    });
  }
  return out;
}

const INPUT_LABELS: Record<string, string> = {
  customerName: "Name",
  phone: "Phone",
  assignedToEmail: "Assign To (team member)",
  travelStartDate: "Travel Date",
  destination: "Destination",
  city: "City",
  nights: "Nights",
  itinerary: "Itinerary",
  adults: "Adults",
  travelers: "Travelers *",
  departureCountry: "Departure Country",
  departureCity: "Departure City",
  services: "Services",
  // Email and rooms are optional in Travel CRM and therefore never
  // manual dialog inputs: present values map/send automatically.
  leadSource: "Received",
  leadType: "Type",
  leadStage: "Stage",
};

/**
 * Fixed dialog order: Name + Phone always at the top (prefilled
 * from the canonical WACRM flow-run values, editable), then the
 * Workspace-prefilled funnel block (Received, Type, Stage —
 * editable Workspace-style dropdowns), then the remaining
 * completion fields, with the itinerary editor last.
 */
const DIALOG_ORDER: readonly string[] = [
  "customerName",
  "phone",
  "leadSource",
  "leadType",
  "leadStage",
  "departureCountry",
  "departureCity",
  "travelers",
  "services",
  "assignedToEmail",
  "travelStartDate",
  "itinerary",
];

function dialogOrderIndex(field: string): number {
  const i = DIALOG_ORDER.indexOf(field);
  return i === -1 ? DIALOG_ORDER.length : i;
}

const INPUT_KINDS: Record<string, DialogInput["kind"]> = {
  assignedToEmail: "member",
  travelStartDate: "date",
  nights: "number",
  itinerary: "itinerary",
  travelers: "travelers",
  adults: "number",
  leadSource: "select",
  leadType: "select",
  leadStage: "select",
  services: "multi",
};

const OPTION_KEYS: Record<string, string> = {
  leadSource: "leadSource",
  leadType: "leadType",
  leadStage: "leadStage",
  services: "services",
};

function asLookupList(value: unknown): LookupOption[] | null {
  if (!Array.isArray(value)) return null;
  const out: LookupOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.value !== "string" || !rec.value.trim()) continue;
    out.push({
      value: rec.value.trim(),
      label:
        typeof rec.label === "string" && rec.label.trim()
          ? rec.label.trim()
          : rec.value.trim(),
      destinationValue:
        typeof rec.destinationValue === "string" && rec.destinationValue.trim()
          ? rec.destinationValue.trim()
          : null,
    });
  }
  return out;
}

function resolveItineraryLookups(
  options: Record<string, LookupOption[] | null> | null,
  prefill: Record<string, unknown>,
  topDestinations?: LookupOption[] | null,
  topCities?: LookupOption[] | null,
  topByDest?: Record<string, LookupOption[]> | null,
): {
  destinations: LookupOption[] | null;
  cities: LookupOption[] | null;
  citiesByDestination: Record<string, LookupOption[]> | null;
} {
  const destinations =
    (Array.isArray(topDestinations) ? topDestinations : null) ??
    (options ? asLookupList(options.destinations) : null);
  const cities =
    (Array.isArray(topCities) ? topCities : null) ??
    (options ? asLookupList(options.cities) : null);
  let citiesByDestination: Record<string, LookupOption[]> | null = null;
  if (topByDest && typeof topByDest === "object") {
    citiesByDestination = topByDest;
  } else if (
    prefill.citiesByDestination &&
    typeof prefill.citiesByDestination === "object"
  ) {
    citiesByDestination = prefill.citiesByDestination as Record<
      string,
      LookupOption[]
    >;
  }
  return { destinations, cities, citiesByDestination };
}

/**
 * Pure derivation of dialog inputs: Name + Phone always lead
 * (prefilled canonical values, editable), then Received/Type/Stage
 * (initialized from the Workspace row, editable — edits ride the
 * normal override path to both the Travel CRM payload and, after
 * a successful create, back to the Workspace row), then the
 * remaining fields that still need user input.
 */
export function buildDialogInputs(
  mapping: MappingPayload,
  prefill: Record<string, unknown>,
  options: Record<string, LookupOption[] | null> | null,
  assignmentIssue: string | null,
  receivedOptions?: LookupOption[] | null,
  itineraryLookups?: {
    destinations?: LookupOption[] | null;
    cities?: LookupOption[] | null;
    citiesByDestination?: Record<string, LookupOption[]> | null;
  } | null,
): DialogInput[] {
  const wanted = new Set<string>();
  for (const f of mapping.missing) {
    if (INPUT_LABELS[f] !== undefined) wanted.add(f);
  }
  for (const a of mapping.ambiguous) {
    if (INPUT_LABELS[a.field] !== undefined) wanted.add(a.field);
  }
  for (const v of mapping.invalid) {
    if (INPUT_LABELS[v.field] !== undefined) wanted.add(v.field);
  }
  if (assignmentIssue !== null || prefill.assignedToEmail == null) {
    wanted.add("assignedToEmail");
  }
  const needsItinerary =
    wanted.has("itinerary") ||
    wanted.has("destination") ||
    wanted.has("city") ||
    wanted.has("nights");
  const prefilledRows = seedItineraryDialogRows(prefill);
  const showItinerary = needsItinerary || prefilledRows.length > 0;
  if (showItinerary) {
    wanted.delete("destination");
    wanted.delete("city");
    wanted.delete("nights");
    wanted.add("itinerary");
  }
  // Name + Phone always lead the dialog (prefilled canonical WACRM
  // values, editable). Never a second source: value comes from
  // prefill.customerName / prefill.phone already derived server-side
  // from the flow run's contact/submission data.
  wanted.add("customerName");
  wanted.add("phone");
  // Adults (missing/invalid/ambiguous) opens the grouped Travelers
  // section instead of a lone number input — counts plus optional
  // per-child ages in one compact surface.
  if (wanted.has("adults")) {
    wanted.delete("adults");
    wanted.add("travelers");
  }
  // Received/Type/Stage always render as editable Workspace-style
  // dropdowns prefilled from the selected row — never gated on the
  // mapping flagging them, so Received can never go missing and
  // Type/Stage can never degrade to text inputs. The agent's picks
  // ride the normal override path to both the Travel CRM payload
  // and, after a successful create, back to the Workspace row.
  // Clearing one simply omits the override, so the row/default
  // path applies (empty Type → Fresh, empty Stage → New Lead).
  wanted.add("leadSource");
  wanted.add("leadType");
  wanted.add("leadStage");
  // Departure Country/City always render as catalog selects
  // prefilled from the saved flow defaults (server prefill) —
  // never gated on the mapping flagging them, so saving Travel
  // CRM Settings (which marks them available) can never hide
  // them. Per-lead edits ride the normal override path to the
  // payload only; saved Settings are never modified here.
  wanted.add("departureCountry");
  wanted.add("departureCity");
  // Services multi-select renders whenever the mapping still needs
  // it OR the dialog already carries preselected services (flow
  // defaults or lead data) — otherwise saved defaults would
  // prefill invisibly and the agent could never review or adjust
  // them for one lead. The dedicated server override path means an
  // edit can never collide with mapped/default values as a false
  // ambiguity.
  const prefilledServices = Array.isArray(prefill.services)
    ? (prefill.services as unknown[]).filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      )
    : [];
  if (prefilledServices.length > 0) {
    wanted.add("services");
  }
  const ambiguousBy = new Map(mapping.ambiguous.map((a) => [a.field, a.candidates]));
  const resolved = resolveItineraryLookups(
    options,
    prefill,
    itineraryLookups?.destinations ?? null,
    itineraryLookups?.cities ?? null,
    itineraryLookups?.citiesByDestination ?? null,
  );
  const ordered = [...wanted].sort(
    (a, b) => dialogOrderIndex(a) - dialogOrderIndex(b),
  );
  return ordered.map((field) => {
    if (field === "departureCountry" || field === "departureCity") {
      // Catalog selects, never text inputs: country from the
      // copied catalog, cities for the prefilled country (the
      // live selected country refreshes the list at render).
      // Values are the saved flow defaults via server prefill —
      // initial values only, freely editable per lead.
      const prefillCountry =
        typeof prefill.departureCountry === "string"
          ? prefill.departureCountry
          : "";
      const depOptions =
        field === "departureCountry"
          ? DEPARTURE_COUNTRY_OPTIONS
          : departureCityOptions(prefillCountry).map((o) => ({
              value: o.value,
              label: o.label,
            }));
      return {
        field,
        label: INPUT_LABELS[field] ?? field,
        kind: "select" as const,
        value: prefill[field] ?? null,
        options: depOptions,
        hint: ambiguousBy.has(field)
          ? `Multiple values found: ${ambiguousBy.get(field)?.join(" / ")} — pick or type the correct one.`
          : undefined,
      };
    }
    if (field === "travelers") {
      const adultHints = ambiguousBy.get("adults") ?? [];
      return {
        field,
        label: INPUT_LABELS[field] ?? field,
        kind: "travelers" as const,
        value: seedTravelerForm(prefill),
        options: null,
        hint:
          adultHints.length > 0
            ? `Multiple values found: ${adultHints.join(" / ")} — pick the correct one.`
            : undefined,
      };
    }
    if (field === "itinerary") {
      const legacyHints: string[] = [];
      for (const key of ["itinerary", "destination", "city", "nights"]) {
        const cands = ambiguousBy.get(key);
        if (cands && cands.length > 0) legacyHints.push(...cands);
      }
      return {
        field,
        label: INPUT_LABELS[field] ?? field,
        kind: "itinerary" as const,
        value: prefilledRows,
        options: resolved.destinations,
        cities: resolved.cities,
        citiesByDestination: resolved.citiesByDestination,
        hint:
          legacyHints.length > 0
            ? `Multiple values found: ${[...new Set(legacyHints)].join(" / ")} — pick the correct one.`
            : undefined,
      };
    }
    const optionKey = OPTION_KEYS[field];
    const liveOptions =
      field === "leadSource" && receivedOptions && receivedOptions.length > 0
        ? receivedOptions
        : optionKey
          ? (options?.[optionKey] ?? null)
          : undefined;
    // Funnel dropdowns never degrade to text inputs: when the
    // server sends no option list, fall back to the canonical
    // Workspace label sets above.
    const fieldOptions =
      liveOptions && liveOptions.length > 0
        ? liveOptions
        : (FUNNEL_FALLBACK_OPTIONS[field] ?? undefined);
    return {
      field,
      label: INPUT_LABELS[field] ?? field,
      kind: INPUT_KINDS[field] ?? "text",
      value: prefill[field] ?? (Array.isArray(prefill[field]) ? prefill[field] : null),
      options: fieldOptions,
      hint: ambiguousBy.has(field)
        ? `Multiple values found: ${ambiguousBy.get(field)?.join(" / ")} — pick or type the correct one.`
        : undefined,
    };
  });
}

/** Seed editable inputs from known values (true prefill). */
export function seedValues(prefill: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, raw] of Object.entries(prefill)) {
    // Itinerary has its own row state; rowLead* keys feed the
    // read-only funnel block directly (never dialog overrides).
    if (field === "itinerary") continue;
    if (field === "rowLeadSource" || field === "rowLeadType" || field === "rowLeadStage") continue;
    // Phone seeds in display form (Indian +91 shown as 10 digits);
    // submit() maps edits back to canonical — payloads stay canonical.
    if (field === "phone" && typeof raw === "string" && raw) {
      out[field] = formatPhoneForDisplay(raw);
      continue;
    }
    if (typeof raw === "string" && raw) out[field] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) out[field] = String(raw);
    else if (Array.isArray(raw) && raw.length > 0) out[field] = raw.map(String).join("; ");
  }
  return out;
}

/**
 * Country options for the dialog Departure Country select: the
 * exact copied Travel CRM catalog, sorted exactly like the
 * Settings Departure Defaults section (never fetched, never
 * hardcoded locally).
 */
const DEPARTURE_COUNTRY_OPTIONS: LookupOption[] = [...DEPARTURE_COUNTRIES]
  .sort((a, b) => a.localeCompare(b))
  .map((name) => ({ value: name, label: name }));

/**
 * City rule shared with Settings: changing country clears an
 * incompatible city rather than keeping a value the new country
 * cannot offer. Pure — unit-tested.
 */
export function resolveDepartureCityOnCountryChange(
  country: string,
  city: string,
): string {
  return city && !isDepartureCityInCountry(country, city) ? "" : city;
}

/**
 * Workspace column names behind the three funnel dropdowns —
 * the chip lookup keys, so dialog chips can never disagree with
 * the Workspace cells on colors.
 */
const FUNNEL_WORKSPACE_FIELD_NAMES: Record<string, string> = {
  leadSource: LEAD_RECEIVED_FIELD_NAME,
  leadType: LEAD_TYPE_FIELD_NAME,
  leadStage: STAGE_FIELD_NAME,
};

/**
 * Last-resort funnel options: the exact canonical Workspace label
 * sets (values = labels — no live enums available to map). Used
 * ONLY when the server sends no option list (lookups unreachable);
 * the server then falls back to the row/default path and Travel
 * CRM validates authoritatively. This keeps Received/Type/Stage
 * dropdowns in every reachable state instead of degrading to
 * free-text inputs.
 */
const FUNNEL_FALLBACK_OPTIONS: Record<string, LookupOption[]> = {
  leadSource: LEAD_RECEIVED_OPTIONS.map((label) => ({ value: label, label })),
  leadType: LEAD_TYPE_OPTIONS.map((label) => ({ value: label, label })),
  leadStage: STAGE_OPTIONS.map((label) => ({ value: label, label })),
};

/**
 * Received/Type/Stage dropdown: the exact Workspace single-select
 * surface, composed from the shared Workspace pieces (chip view,
 * trigger styling, Clear-first, search threshold, chip lookup) —
 * controlled instead of self-saving, so picks stay local dialog
 * state until Create. Options arrive pre-ordered from the server
 * (canonical Workspace labels carrying live Travel CRM enum
 * values); the submitted value is the enum, labels only display.
 * Clear submits empty, which omits the override so the row/default
 * path applies. Nothing here persists — Workspace writes happen
 * server-side only after a successful Travel CRM create.
 *
 * Exported for render tests (same pattern as CustomCell).
 */
export function FunnelSelect({
  label,
  value,
  options,
  fieldName,
  onChange,
}: {
  label: string;
  value: string;
  options: LookupOption[];
  fieldName: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const showSearch = options.length > OPTION_SEARCH_THRESHOLD;
  const visible = showSearch
    ? filterCellOptions(
        options.map((o) => ({ value: o.value, label: o.label })),
        query,
      )
    : options;
  const selectedLabel = options.find((o) => o.value === value)?.label ?? null;
  const selectedChip =
    selectedLabel !== null ? getSelectChip(fieldName, selectedLabel) : null;
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v === "__clear__" ? "" : (v ?? ""))}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <SelectTrigger className={SELECT_CELL_TRIGGER_CLASS} aria-label={label}>
        <SelectValue placeholder={`Select ${label}`}>
          {selectedLabel == null || selectedLabel === "" ? undefined : selectedChip ? (
            <SelectChipView chip={selectedChip}>{selectedLabel}</SelectChipView>
          ) : (
            selectedLabel
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__clear__">
          <span className="text-muted-foreground">Clear</span>
        </SelectItem>
        {showSearch && (
          <OptionSearchBox query={query} onQuery={setQuery} fieldName={label} />
        )}
        {visible.map((o) => {
          const chip = getSelectChip(fieldName, o.label);
          return (
            <SelectItem key={o.value} value={o.value}>
              {chip ? <SelectChipView chip={chip}>{o.label}</SelectChipView> : o.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/**
 * Per-lead "Create in Travel CRM" action (Phase 3: connected).
 *
 * Click → prepare (mapping + prefill, no external call unless the
 * payload is already complete) → missing-fields dialog when input
 * is genuinely needed → create → Created + Open link on a REAL
 * external lead ID. "Created" never renders without one.
 * Remount per run (key={runId}) so stale results never leak.
 */
export function TravelCrmAction({
  flowId,
  runId,
  onWorkspaceSynced,
}: {
  flowId: string;
  runId: string;
  /**
   * Fired after a successful create whose dialog edits were synced
   * back to the Workspace row (table reload + drawer patch live in
   * the page). Omitted callers simply skip the refresh.
   */
  onWorkspaceSynced?: (patch: WorkspaceRowPatch, runId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ leadId: string; leadUrl: string } | null>(null);
  const [dialog, setDialog] = useState<{
    mapping: MappingPayload;
    prefill: Record<string, unknown>;
    options: Record<string, LookupOption[] | null> | null;
    receivedOptions: LookupOption[] | null;
    destinations: LookupOption[] | null;
    cities: LookupOption[] | null;
    citiesByDestination: Record<string, LookupOption[]> | null;
    assignmentIssue: string | null;
  } | null>(null);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [itineraryRows, setItineraryRows] = useState<ItineraryDialogRow[]>([]);
  const [travelers, setTravelers] = useState<TravelerForm>(() =>
    seedTravelerForm({}),
  );

  useEffect(() => {
    if (!dialog) return;
    if (dialogInputs().some((i) => i.field === "assignedToEmail")) {
      fetch("/api/account/members", { cache: "no-store" })
        .then((r) => r.json().catch(() => null))
        .then((json) => {
          const list = (json as { members?: TeamMember[] } | null)?.members;
          setMembers(Array.isArray(list) ? list : []);
        })
        .catch(() => setMembers([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog !== null]);

  function dialogInputs(): DialogInput[] {
    if (!dialog) return [];
    return buildDialogInputs(
      dialog.mapping,
      dialog.prefill,
      dialog.options,
      dialog.assignmentIssue,
      dialog.receivedOptions,
      {
        destinations: dialog.destinations,
        cities: dialog.cities,
        citiesByDestination: dialog.citiesByDestination,
      },
    );
  }

  async function callApi(overrides?: Record<string, unknown>): Promise<PrepareResult | null> {
    const res = await fetch("/api/integrations/travel-crm/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        overrides ? { flow_id: flowId, flow_run_id: runId, overrides } : { flow_id: flowId, flow_run_id: runId },
      ),
    });
    return (await res.json().catch(() => null)) as PrepareResult | null;
  }

  function openDialog(json: PrepareResult & { mapping: MappingPayload; prefill: Record<string, unknown> }) {
    setValues(seedValues(json.prefill));
    setItineraryRows(seedItineraryDialogRows(json.prefill));
    setTravelers(seedTravelerForm(json.prefill));
    setMembers(null);
    setDialog({
      mapping: json.mapping,
      prefill: json.prefill,
      options: json.options ?? null,
      receivedOptions: json.receivedOptions ?? null,
      destinations: json.destinations ?? null,
      cities: json.cities ?? null,
      citiesByDestination: json.citiesByDestination ?? null,
      assignmentIssue: json.assignmentIssue ?? null,
    });
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const json = await callApi();
      if (!json) throw new Error("Request failed.");
      if (json.success && json.leadId && json.leadUrl) {
        setCreated({ leadId: json.leadId, leadUrl: json.leadUrl });
        return;
      }
      if (!json.success && json.code === "MISSING_FIELDS" && json.mapping && json.prefill) {
        openDialog(json as PrepareResult & { mapping: MappingPayload; prefill: Record<string, unknown> });
        return;
      }
      throw new Error(json.error ?? "Request failed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const inputs = dialogInputs();
    const overrides: Record<string, unknown> = {};
    for (const input of inputs) {
      // Itinerary has its own row state — never a generic override.
      if (input.field === "itinerary") continue;
      // Services always sends (even empty): clearing every checkbox
      // must reach the server as an explicit empty selection rather
      // than vanishing into "no override".
      if (input.field === "services") {
        overrides.services = values.services ?? "";
        continue;
      }
      const raw = (values[input.field] ?? "").trim();
      if (input.field === "phone") continue;
      if (raw) overrides[input.field === "assignedToEmail" ? "assignedUserId" : input.field] = raw;
    }
    // Phone: the input shows the display form (Indian +91 stripped);
    // map edits back to canonical so the payload keeps the
    // international number the integration expects.
    if (inputs.some((i) => i.field === "phone")) {
      const rawPhone = (values.phone ?? "").trim();
      if (rawPhone) {
        const prefillPhone = dialog?.prefill.phone;
        overrides.phone = displayToCanonicalPhone(
          rawPhone,
          isIndianCountryCodeNumber(
            typeof prefillPhone === "string" ? prefillPhone : null,
          ),
        );
      }
    }
    if (inputs.some((i) => i.field === "itinerary")) {
      try {
        const itin = itineraryDialogRowsToOverrides(itineraryRows);
        // Send only when the agent provided at least one complete
        // row; an empty editor leaves itinerary to server defaults
        // (which stay missing when unconfigured — never invented).
        if (itin.length > 0) overrides.itinerary = itin;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Invalid itinerary.");
        return;
      }
    }
    if (inputs.some((i) => i.field === "travelers")) {
      const travelersError = validateTravelerForm(travelers);
      if (travelersError) {
        setError(travelersError);
        return;
      }
      const t = travelerFormToOverrides(travelers);
      overrides.adults = t.adults;
      if (t.childrenWithBed !== null) overrides.childrenWithBed = t.childrenWithBed;
      if (t.childrenWithoutBed !== null) overrides.childrenWithoutBed = t.childrenWithoutBed;
      if (t.infants !== null) overrides.infants = t.infants;
      overrides.childrenWithBedAges = t.childrenWithBedAges;
      overrides.childrenWithoutBedAges = t.childrenWithoutBedAges;
      overrides.infantAges = t.infantAges;
    }
    setBusy(true);
    setError(null);
    try {
      const json = await callApi(overrides);
      if (!json) throw new Error("Request failed.");
      if (json.success && json.leadId && json.leadUrl) {
        // Two-way sync: the server persisted dialog edits to the
        // Workspace row (only after the successful create above).
        // Surface sync failures with the dialog still open for
        // retry; the created lead is never duplicated by retrying.
        // The table refreshes only when synced values landed.
        const patch: WorkspaceRowPatch = {
          answers: {},
          name: null,
          phone: null,
          customValues: {},
          ...(json.workspaceSync?.rowPatch ?? {}),
        };
        const hasPatch =
          Object.keys(patch.answers).length > 0 ||
          Object.keys(patch.customValues).length > 0 ||
          patch.name !== null ||
          patch.phone !== null;
        const failures = json.workspaceSync?.failed ?? [];
        if (failures.length > 0) {
          const details = failures.map((f) => `${f.field}: ${f.error}`).join("; ");
          setError(`Lead created, but Workspace sync failed: ${details}. You can retry Create.`);
          if (hasPatch) onWorkspaceSynced?.(patch, runId);
          return;
        }
        if (hasPatch) onWorkspaceSynced?.(patch, runId);
        setDialog(null);
        setCreated({ leadId: json.leadId, leadUrl: json.leadUrl });
        return;
      }
      if (!json.success && json.code === "MISSING_FIELDS" && json.mapping && json.prefill) {
        const seeded = seedValues(json.prefill);
        setValues((prev) => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(seeded)) {
            if (!(k in next)) next[k] = v;
          }
          return next;
        });
        setItineraryRows((prev) =>
          prev.length > 0 ? prev : seedItineraryDialogRows(json.prefill ?? {}),
        );
        // Server echoes submitted traveler values in prefill, so a
        // re-round reseed preserves the agent's entries verbatim.
        setTravelers(seedTravelerForm(json.prefill ?? {}));
        setDialog({
          mapping: json.mapping,
          prefill: json.prefill,
          options: json.options ?? null,
          receivedOptions: json.receivedOptions ?? null,
          destinations: json.destinations ?? null,
          cities: json.cities ?? null,
          citiesByDestination: json.citiesByDestination ?? null,
          assignmentIssue: json.assignmentIssue ?? null,
        });
        return;
      }
      throw new Error(json.error ?? "Request failed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  function set(field: string, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  function inputControl(input: DialogInput) {
    // Grouped Travelers section: four compact counts in one row
    // plus optional per-child age fields that appear only while
    // their count is > 0. Same dialog styling as other inputs.
    if (input.kind === "travelers") {
      const cwbCount = travelerAgeCount(travelers.cwb);
      const cwobCount = travelerAgeCount(travelers.cwob);
      const infantCount = travelerAgeCount(travelers.infants);
      const setCount = (key: "adults" | "cwb" | "cwob" | "infants", v: string) => {
        setTravelers((prev) => {
          const next = { ...prev, [key]: v };
          if (key === "cwb") next.cwbAges = resizeAgeRows(prev.cwbAges, travelerAgeCount(v));
          if (key === "cwob") next.cwobAges = resizeAgeRows(prev.cwobAges, travelerAgeCount(v));
          if (key === "infants") next.infantAges = resizeAgeRows(prev.infantAges, travelerAgeCount(v));
          return next;
        });
      };
      const setAge = (
        group: "cwbAges" | "cwobAges" | "infantAges",
        count: number,
        index: number,
        v: string,
      ) => {
        setTravelers((prev) => {
          const base = resizeAgeRows(prev[group], count);
          base[index] = v;
          return { ...prev, [group]: base };
        });
      };
      const ageRows = (
        group: "cwbAges" | "cwobAges" | "infantAges",
        count: number,
        single: string,
      ) => {
        if (count <= 0) return null;
        const rows = [...travelers[group]];
        while (rows.length < count) rows.push("");
        return (
          <>
            {rows.slice(0, count).map((age, i) => {
              const label = `${single} ${i + 1} Age`;
              return (
                <div key={`${group}-${i}`} className="grid gap-1">
                  <Label htmlFor={`tmc-${group}-${i}`} className="text-xs">
                    {label}
                  </Label>
                  <Input
                    id={`tmc-${group}-${i}`}
                    aria-label={label}
                    type="number"
                    min={0}
                    className="h-8"
                    value={age}
                    onChange={(e) => setAge(group, count, i, e.target.value)}
                    placeholder="Age (optional)"
                  />
                </div>
              );
            })}
          </>
        );
      };
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-4 gap-2">
            {(
              [
                { key: "adults", label: "Adults", min: 1, placeholder: "1" },
                { key: "cwb", label: "CWB", min: 0, placeholder: "" },
                { key: "cwob", label: "CWOB", min: 0, placeholder: "" },
                { key: "infants", label: "Infants", min: 0, placeholder: "" },
              ] as const
            ).map((f) => (
              <div key={f.key} className="grid gap-1">
                <Label htmlFor={`tmc-travelers-${f.key}`} className="text-xs">
                  {f.label}
                </Label>
                <Input
                  id={`tmc-travelers-${f.key}`}
                  aria-label={f.label}
                  type="number"
                  min={f.min}
                  className="h-8"
                  value={travelers[f.key]}
                  onChange={(e) => setCount(f.key, e.target.value)}
                  placeholder={f.placeholder || undefined}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            CWB = Child with Bed | CWOB = Child without Bed | Infants = Visa charges only
          </p>
          {(cwbCount > 0 || cwobCount > 0 || infantCount > 0) && (
            <div className="grid grid-cols-2 gap-2">
              {ageRows("cwbAges", cwbCount, "CWB")}
              {ageRows("cwobAges", cwobCount, "CWOB")}
              {ageRows("infantAges", infantCount, "Infant")}
            </div>
          )}
        </div>
      );
    }
    if (input.field === "itinerary") {
      const destinations = input.options ?? [];
      const allCities = input.cities ?? [];
      if (destinations.length === 0 && allCities.length === 0) {
        return (
          <p className="text-muted-foreground text-xs">
            Could not load Travel CRM destinations. Destinations come from Travel
            CRM — no options are shown until it loads.
          </p>
        );
      }
      return (
        <div className="space-y-2">
          {itineraryRows.length === 0 ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-dashed p-2.5">
              <p className="text-muted-foreground text-xs">
                Empty itinerary — add a row to include one.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setItineraryRows(addItineraryDialogRow([]))}
              >
                <Plus className="h-4 w-4" />
                Add
              </Button>
            </div>
          ) : (
            <>
              {itineraryRows.map((row, i) => {
                const cityOptions = row.destination
                  ? citiesForDestination(allCities, row.destination)
                  : [];
                return (
                  <div key={i} className="grid grid-cols-[1fr_1fr_64px_auto] items-end gap-2">
                    <div className="grid gap-1">
                      <Label htmlFor={`lead-itin-dest-${i}`} className="text-xs">Destination</Label>
                      <Select
                        value={row.destination || undefined}
                        onValueChange={(v) =>
                          setItineraryRows((prev) =>
                            updateItineraryDialogDestination(prev, i, v ?? "", allCities),
                          )
                        }
                      >
                        <SelectTrigger id={`lead-itin-dest-${i}`} aria-label="Destination" className="h-8 w-full">
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                        <SelectContent>
                          {destinations.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor={`lead-itin-city-${i}`} className="text-xs">City</Label>
                      <Select
                        value={row.city || undefined}
                        onValueChange={(v) =>
                          setItineraryRows((prev) =>
                            prev.map((r, idx) => (idx === i ? { ...r, city: v ?? "" } : r)),
                          )
                        }
                        disabled={!row.destination}
                      >
                        <SelectTrigger id={`lead-itin-city-${i}`} aria-label="City" className="h-8 w-full">
                          <SelectValue placeholder={row.destination ? "Select" : "Pick destination first"} />
                        </SelectTrigger>
                        <SelectContent>
                          {cityOptions.map((o) => (
                            <SelectItem key={`${o.destinationValue ?? ""}:${o.value}`} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-1">
                      <Label htmlFor={`lead-itin-nights-${i}`} className="text-xs">Nights</Label>
                      <Input
                        id={`lead-itin-nights-${i}`}
                        aria-label="Nights"
                        type="number"
                        min={1}
                        className="h-8"
                        value={row.nights}
                        onChange={(e) =>
                          setItineraryRows((prev) =>
                            prev.map((r, idx) => (idx === i ? { ...r, nights: e.target.value } : r)),
                          )
                        }
                        placeholder="4"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2"
                      onClick={() => setItineraryRows((prev) => removeItineraryDialogRow(prev, i))}
                      aria-label="Remove itinerary row"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setItineraryRows((prev) => addItineraryDialogRow(prev))}
              >
                <Plus className="h-4 w-4" />
                Add More
              </Button>
            </>
          )}
        </div>
      );
    }
    const val = values[input.field] ?? "";
    if (input.field === "assignedToEmail") {
      return (
        <Select value={val} onValueChange={(v) => set(input.field, v ?? "")}>
          <SelectTrigger aria-label={input.label}>
            <SelectValue placeholder="Select team member" />
          </SelectTrigger>
          <SelectContent>
            {(members ?? []).map((m) => (
              <SelectItem key={m.user_id} value={m.user_id}>
                {m.full_name ?? m.email ?? m.user_id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    if (input.kind === "multi") {
      const choices =
        input.options && input.options.length > 0
          ? input.options.map((o) => o.label)
          : [...TRAVEL_CRM_SERVICE_LABELS];
      const current = splitServiceLabels(val);
      const has = (label: string) =>
        current.some((c) => c.toLowerCase() === label.toLowerCase());
      const toggle = (label: string) => {
        const next = has(label)
          ? current.filter((c) => c.toLowerCase() !== label.toLowerCase())
          : [...current, label];
        set(input.field, joinServiceLabels(next));
      };
      return (
        <div className="grid gap-1.5" role="group" aria-label={input.label}>
          {choices.map((label) => (
            <label
              key={label}
              className="text-foreground flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-muted"
            >
              <Checkbox
                checked={has(label)}
                onCheckedChange={() => toggle(label)}
                aria-label={label}
              />
              <span className="truncate">{label}</span>
            </label>
          ))}
        </div>
      );
    }
    if (input.kind === "select" && input.options && input.options.length > 0) {
      // Departure Country/City catalog selects (same catalog +
      // rule as Settings): cities follow the live selected
      // country; a country change clears an incompatible city.
      // Values submit through the normal override path (per-lead
      // only — saved Settings are never touched).
      if (input.field === "departureCountry" || input.field === "departureCity") {
        const prefillCountry =
          typeof dialog?.prefill.departureCountry === "string"
            ? (dialog.prefill.departureCountry as string)
            : "";
        const country = values.departureCountry ?? prefillCountry;
        if (input.field === "departureCountry") {
          return (
            <Select
              value={val}
              onValueChange={(v) => {
                const next = v ?? "";
                set("departureCountry", next);
                set(
                  "departureCity",
                  resolveDepartureCityOnCountryChange(next, values.departureCity ?? ""),
                );
              }}
            >
              <SelectTrigger aria-label={input.label}>
                <SelectValue placeholder={`Select ${input.label}`} />
              </SelectTrigger>
              <SelectContent>
                {(input.options ?? []).map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        }
        const cities = departureCityOptions(country);
        return (
          <Select
            value={val}
            onValueChange={(v) => set(input.field, v ?? "")}
            disabled={!country}
          >
            <SelectTrigger aria-label={input.label}>
              <SelectValue placeholder={country ? "Select city" : "Pick country first"} />
            </SelectTrigger>
            <SelectContent>
              {cities.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      }
      // Funnel fields render through the shared Workspace
      // single-select surface (chips, Clear-first, search) — never
      // the plain dialog select below.
      const funnelField = FUNNEL_WORKSPACE_FIELD_NAMES[input.field];
      if (funnelField !== undefined) {
        return (
          <FunnelSelect
            label={input.label}
            value={val}
            options={input.options}
            fieldName={funnelField}
            onChange={(v) => set(input.field, v)}
          />
        );
      }
      return (
        <Select value={val} onValueChange={(v) => set(input.field, v ?? "")}>
          <SelectTrigger aria-label={input.label}>
            <SelectValue placeholder={`Select ${input.label}`} />
          </SelectTrigger>
          <SelectContent>
            {input.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    return (
      <Input
        aria-label={input.label}
        type={input.kind === "date" ? "date" : input.kind === "number" ? "number" : input.kind === "member" ? "text" : "text"}
        value={val}
        onChange={(e) => set(input.field, e.target.value)}
        placeholder={input.hint ?? input.label}
      />
    );
  }

  if (created !== null) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Created in Travel CRM</p>
        <Button type="button" variant="outline" className="w-full" render={<a href={created.leadUrl} target="_blank" rel="noreferrer" />}>
          <ExternalLink className="mr-2 h-4 w-4" />
          Open in Travel CRM
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={busy}
        onClick={start}
      >
        {busy && !dialog ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Creating…
          </>
        ) : (
          <>
            <Plane className="mr-2 h-4 w-4" />
            Create in Travel CRM
          </>
        )}
      </Button>
      {error !== null && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
      <Dialog open={dialog !== null} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Complete Travel CRM fields</DialogTitle>
            <DialogDescription>
              Name and Phone are prefilled from the Workspace row and editable.
              Received, Type, and Stage are also prefilled and editable.
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[60vh] gap-3 overflow-y-auto pr-1">
            {dialogInputs().map((input) => (
              <div key={input.field} className="grid gap-1.5">
                <Label htmlFor={`tmc-${input.field}`}>{input.label}</Label>
                {inputControl(input)}
                {input.hint !== undefined && (
                  <p className="text-xs text-muted-foreground">{input.hint}</p>
                )}
              </div>
            ))}
          </div>
          {error !== null && (
            <p role="alert" className="text-xs text-red-500">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="button" disabled={busy} onClick={submit}>
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
