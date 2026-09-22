/**
 * Travel CRM cross-app navigation URL.
 *
 * Single resolution rule shared by the sidebar card, the Settings
 * form, and the Overview tile — do NOT inline
 * `account.travel_crm_url || DEFAULT` in components.
 *
 * - Valid configured URL → the configured URL (trimmed).
 * - null/empty/whitespace → DEFAULT_TRAVEL_CRM_URL, so the sidebar
 *   card is always available (existing NULL rows stay compatible,
 *   no data migration needed).
 * - Invalid values can never be saved (Settings validates
 *   http(s) before writing); the resolver still never returns one —
 *   anything unparsable falls back to the default rather than
 *   rendering a broken link.
 */

export const DEFAULT_TRAVEL_CRM_URL = 'https://app.travelagencycrm.in';

/** True for absolute http(s) URLs. Rejects javascript:, data:, etc. */
export function isValidTravelCrmUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Effective Travel CRM URL for an account. Always returns a usable
 * absolute URL — never null, never empty, never a broken link.
 */
export function getTravelCrmUrl(account?: {
  travel_crm_url?: string | null;
} | null): string {
  const configured = account?.travel_crm_url?.trim();
  if (configured && isValidTravelCrmUrl(configured)) return configured;
  return DEFAULT_TRAVEL_CRM_URL;
}
