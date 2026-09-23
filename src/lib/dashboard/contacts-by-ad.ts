// Pure helpers for the "Contacts by Ad" donut: payload parsing,
// ad-URL display shortening, and empty-state classification.
// Attribution itself lives server-side (migration 081): one row
// per contact bucketed by its stored first-touch source_url.

import {
  AD_OTHERS_COLOR,
  NO_AD_COLOR,
  NO_AD_KEY,
  OTHERS_KEY,
  assignFlowColors,
} from './flow-colors'
import type { AdBucketRow } from './types'

export interface NormalizedContactsByAd {
  totalContacts: number
  rows: AdBucketRow[]
}

/**
 * Validate + normalize the RPC `contactsByAd` payload. Malformed
 * rows are dropped; surviving rows are sorted contacts-desc with
 * the No-Ad bucket forced last (mirroring the server order).
 */
export function normalizeContactsByAd(input: unknown): NormalizedContactsByAd {
  if (!input || typeof input !== 'object') return { totalContacts: 0, rows: [] }
  const r = input as Record<string, unknown>
  const totalContacts =
    typeof r.totalContacts === 'number' && Number.isFinite(r.totalContacts) && r.totalContacts >= 0
      ? Math.floor(r.totalContacts)
      : 0
  const rows: AdBucketRow[] = Array.isArray(r.rows)
    ? (r.rows as unknown[]).flatMap((d) => {
        if (!d || typeof d !== 'object') return []
        const row = d as Record<string, unknown>
        if (
          typeof row.adKey !== 'string' ||
          row.adKey.length === 0 ||
          typeof row.adLabel !== 'string' ||
          row.adLabel.length === 0 ||
          typeof row.contacts !== 'number' ||
          !Number.isFinite(row.contacts) ||
          row.contacts < 0 ||
          typeof row.pct !== 'number' ||
          !Number.isFinite(row.pct)
        ) {
          return []
        }
        return [
          {
            adKey: row.adKey,
            adLabel: row.adLabel,
            contacts: Math.floor(row.contacts),
            pct: row.pct,
          },
        ]
      })
    : []
  rows.sort(
    (a, b) =>
      Number(a.adKey === NO_AD_KEY) - Number(b.adKey === NO_AD_KEY) ||
      b.contacts - a.contacts,
  )
  return { totalContacts, rows }
}

/**
 * Render the useful human-readable portion of a stored ad URL:
 * strip scheme/www/trailing slash, then middle-truncate long
 * values. The full URL stays available via title/tooltip.
 */
export function shortAdUrl(url: string): string {
  const stripped = url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
  if (stripped.length <= 44) return stripped
  return `${stripped.slice(0, 32)}…${stripped.slice(-8)}`
}

export type AdChartState = 'empty' | 'no-ads' | 'ready'

/**
 * Which visual the donut section shows: nothing messaged at all,
 * messaged-but-none-ad-sourced, or the chart.
 */
export function adChartState(totalContacts: number, rows: AdBucketRow[]): AdChartState {
  if (totalContacts <= 0 || rows.length === 0) return 'empty'
  const hasAd = rows.some((r) => r.adKey !== NO_AD_KEY && r.contacts > 0)
  return hasAd ? 'ready' : 'no-ads'
}

/**
 * Resolve a stored ad/source value to a safe link target, or null
 * when it must not render as a link. Absolute http(s) URLs are used
 * verbatim (exact stored destination preserved); protocol-less
 * values like `fb.me/…` are upgraded to https. Anything else —
 * javascript:/data:/ftp: schemes, bare words ("No Ad"), empty
 * strings — returns null. Hostnames must contain a dot so plain
 * labels never become links.
 */
export function toSafeAdUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || /[\s<>"]/.test(trimmed)) return null
  const https = (host: string) => `https://${host}`
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      const url = new URL(trimmed)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      return trimmed
    }
    const url = new URL(https(trimmed))
    if (!url.hostname.includes('.')) return null
    return https(trimmed)
  } catch {
    return null
  }
}

/**
 * Stable color per bucket through the shared dashboard palette:
 * ad URLs hash to slots (same URL set → same colors across ranges),
 * the grouped remainder takes the Others slot, unattributed takes
 * neutral gray. Never two visible buckets sharing a color.
 */
export function adBucketColors(rows: Pick<AdBucketRow, 'adKey'>[]): Map<string, string> {
  const urlKeys = rows
    .map((r) => r.adKey)
    .filter((k) => k !== NO_AD_KEY && k !== OTHERS_KEY)
  const assigned = assignFlowColors(urlKeys)
  const out = new Map<string, string>()
  for (const { adKey } of rows) {
    if (adKey === NO_AD_KEY) out.set(adKey, NO_AD_COLOR)
    else if (adKey === OTHERS_KEY) out.set(adKey, AD_OTHERS_COLOR)
    else out.set(adKey, assigned.get(adKey) ?? AD_OTHERS_COLOR)
  }
  return out
}
