// ============================================================
// Travel CRM integration configuration (Phase 3: WACRM side).
//
// Server-only: read exclusively in server code (route handlers,
// server services). The secret MUST never carry a NEXT_PUBLIC_
// prefix and must never be sent to the browser — route responses
// are asserted secret-free in tests.
//
//   TRAVEL_CRM_BASE_URL          e.g. https://app.travelagencycrm.in
//   TRAVEL_CRM_INTEGRATION_SECRET  `wacrm_<secret>` Bearer credential
// ============================================================

export const DEFAULT_TRAVEL_CRM_BASE_URL = "https://app.travelagencycrm.in";

export interface TravelCrmConfig {
  /** Normalized origin, no trailing slash. */
  baseUrl: string;
  /** Bearer credential, or null when the integration is not set up. */
  secret: string | null;
}

/** Read integration config from server-only environment. */
export function getTravelCrmConfig(
  env: Record<string, string | undefined> = process.env,
): TravelCrmConfig {
  const rawBase = (env.TRAVEL_CRM_BASE_URL ?? "").trim();
  const baseUrl = (rawBase || DEFAULT_TRAVEL_CRM_BASE_URL).replace(/\/+$/, "");
  const rawSecret = (env.TRAVEL_CRM_INTEGRATION_SECRET ?? "").trim();
  return { baseUrl, secret: rawSecret ? rawSecret : null };
}

/** Public lead URL from a real Travel CRM lead ID. Never invented:
 * `{base}/queries/{id}` is the Travel CRM lead-detail route. */
export function travelCrmLeadUrl(baseUrl: string, leadId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/queries/${leadId}`;
}
