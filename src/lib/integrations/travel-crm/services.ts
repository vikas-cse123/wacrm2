// ============================================================
// Travel CRM per-flow default services.
//
// The six service labels offered in Workspace → Travel CRM
// Settings and in the per-lead dialog. Stored as labels (never
// Travel CRM database IDs); the existing canonicalizeServices
// mechanism resolves them to Travel CRM enum values against
// live lookup options at send time.
// ============================================================

/** Exact service labels, in display order. */
export const TRAVEL_CRM_SERVICE_LABELS: readonly string[] = [
  "Cruise",
  "Flight",
  "Hotel",
  "Vehicle (disposal)",
  "Sightseeing",
  "Add-on Service (Rail, Passport, etc.)",
];

export const TRAVEL_CRM_MAX_SERVICES = 20;
export const TRAVEL_CRM_MAX_SERVICE_LENGTH = 80;

/**
 * Validate + normalize a services list for storage. Trims,
 * drops empties, dedupes (case-insensitive) preserving order.
 * Throws with a human-readable message on invalid input.
 */
export function normalizeServiceLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Services must be a list.");
  }
  if (value.length > TRAVEL_CRM_MAX_SERVICES) {
    throw new Error(`Select at most ${TRAVEL_CRM_MAX_SERVICES} services.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new Error("Each service must be text.");
    }
    const label = raw.trim();
    if (!label) continue;
    if (label.length > TRAVEL_CRM_MAX_SERVICE_LENGTH) {
      throw new Error(`Service "${label.slice(0, 40)}" is too long.`);
    }
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * True when every label is one of the six offered services
 * (case-insensitive). Stored settings should only ever contain
 * offered labels; anything else is rejected at the API boundary.
 */
export function isOfferedServiceLabel(value: string): boolean {
  const key = value.trim().toLowerCase();
  return TRAVEL_CRM_SERVICE_LABELS.some((l) => l.toLowerCase() === key);
}

/** Split a semicolon-joined services string (dialog value state). */
export function splitServiceLabels(value: string): string[] {
  return value
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Join services for dialog value state / override payloads. */
export function joinServiceLabels(values: readonly string[]): string {
  return values.map((v) => v.trim()).filter(Boolean).join("; ");
}
