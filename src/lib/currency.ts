/**
 * Currency — single source of truth for deal-value formatting and
 * the currency picker options.
 *
 * Before this module, ~6 components each defined their own
 * `Intl.NumberFormat(..., { currency: "USD" })` helper with USD
 * baked in. The default currency is now configurable per account
 * (accounts.default_currency, migration 021), so every formatter
 * takes a currency and falls back to DEFAULT_CURRENCY only when
 * nothing is known.
 */

/** App-wide fallback when no account/deal currency is available. */
export const DEFAULT_CURRENCY = "INR";

export interface CurrencyOption {
  /** ISO-4217 code, e.g. "USD". Stored verbatim in the DB. */
  code: string;
  /** Human label for the dropdown, e.g. "US Dollar". */
  label: string;
  /** Symbol for compact display, e.g. "$". */
  symbol: string;
  /** Flag emoji for the picker, e.g. "🇺🇸". */
  flag: string;
}

/**
 * The currencies offered in pickers. Codes must be valid ISO-4217 so
 * `Intl.NumberFormat` renders the right symbol/grouping. Extend this
 * list to offer more — nothing else needs to change.
 */
export const CURRENCIES: CurrencyOption[] = [
  { code: "INR", label: "Indian Rupee", symbol: "₹", flag: "🇮🇳" },
  { code: "USD", label: "US Dollar", symbol: "$", flag: "🇺🇸" },
  { code: "EUR", label: "Euro", symbol: "€", flag: "🇪🇺" },
  { code: "GBP", label: "British Pound", symbol: "£", flag: "🇬🇧" },
  { code: "AED", label: "UAE Dirham", symbol: "د.إ", flag: "🇦🇪" },
  { code: "SGD", label: "Singapore Dollar", symbol: "S$", flag: "🇸🇬" },
  { code: "AUD", label: "Australian Dollar", symbol: "A$", flag: "🇦🇺" },
  { code: "CAD", label: "Canadian Dollar", symbol: "C$", flag: "🇨🇦" },
  { code: "JPY", label: "Japanese Yen", symbol: "¥", flag: "🇯🇵" },
  { code: "THB", label: "Thai Baht", symbol: "฿", flag: "🇹🇭" },
  { code: "MYR", label: "Malaysian Ringgit", symbol: "RM", flag: "🇲🇾" },
  { code: "SAR", label: "Saudi Riyal", symbol: "ر.س", flag: "🇸🇦" },
  { code: "QAR", label: "Qatari Riyal", symbol: "ر.ق", flag: "🇶🇦" },
  { code: "NZD", label: "New Zealand Dollar", symbol: "NZ$", flag: "🇳🇿" },
  { code: "CHF", label: "Swiss Franc", symbol: "CHF", flag: "🇨🇭" },
  { code: "BRL", label: "Brazilian Real", symbol: "R$", flag: "🇧🇷" },
  { code: "CNY", label: "Chinese Yuan", symbol: "¥", flag: "🇨🇳" },
  { code: "ZAR", label: "South African Rand", symbol: "R", flag: "🇿🇦" },
  { code: "NGN", label: "Nigerian Naira", symbol: "₦", flag: "🇳🇬" },
  { code: "MXN", label: "Mexican Peso", symbol: "$", flag: "🇲🇽" },
];

/** True when the code is one of the offered picker currencies. */
export function isSupportedCurrencyCode(code: unknown): code is string {
  if (typeof code !== "string") return false;
  const normalized = code.trim().toUpperCase();
  return CURRENCIES.some((c) => c.code === normalized);
}

/**
 * Normalize a user-supplied currency code (case/whitespace
 * insensitive). Falls back to `fallback` (INR) when empty/missing;
 * throws on an unsupported code.
 */
export function normalizeCurrencyCode(
  code: unknown,
  fallback: string = DEFAULT_CURRENCY,
): string {
  if (code === null || code === undefined) return fallback;
  if (typeof code !== "string" || code.trim() === "") return fallback;
  const normalized = code.trim().toUpperCase();
  if (!isSupportedCurrencyCode(normalized)) {
    throw new Error(`Unsupported currency "${code}".`);
  }
  return normalized;
}

/**
 * Resolve the display currency for a Workspace currency column.
 * Legacy columns created before per-column currencies carry NULL —
 * they render as INR without touching stored values.
 */
export function resolveCurrencyCode(code: unknown): string {
  if (typeof code !== "string" || code.trim() === "") return DEFAULT_CURRENCY;
  const normalized = code.trim().toUpperCase();
  return isSupportedCurrencyCode(normalized) ? normalized : DEFAULT_CURRENCY;
}

/**
 * Locale for grouping a currency's digits. INR uses Indian digit
 * grouping (2,34,234); every other currency uses Western grouping
 * (234,234). Kept Workspace-scoped so deal/pipeline formatting
 * elsewhere is untouched.
 */
export function currencyGroupLocale(code: string): string {
  return resolveCurrencyCode(code) === "INR" ? "en-IN" : "en-US";
}

/**
 * Format a Workspace currency cell: whole units, grouped per the
 * currency's locale, prefixed with the picker's symbol. The stored
 * value stays numeric — this is display-only.
 *
 *   INR 234234 → "₹2,34,234"   USD 234234 → "$234,234"
 *   EUR 234234 → "€234,234"    AED 234234 → "د.إ 234,234"
 *
 * Multi-char symbols that aren't $<something> (د.إ, RM, CHF, …)
 * take a separating space; single-char / $-suffixed symbols
 * ($, €, S$, …) attach directly. Unknown codes fall back to
 * "CODE 1,234" and never throw.
 */
export function formatWorkspaceCurrency(
  value: number,
  currency: unknown = DEFAULT_CURRENCY,
): string {
  const code = resolveCurrencyCode(currency);
  const amount = Number(value) || 0;
  let grouped: string;
  try {
    grouped = new Intl.NumberFormat(currencyGroupLocale(code), {
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    grouped = new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 0,
    }).format(amount);
  }
  const symbol = CURRENCIES.find((c) => c.code === code)?.symbol ?? `${code} `;
  if (symbol.endsWith(" ")) {
    return `${symbol}${grouped}`;
  }
  if (symbol.length === 1 || symbol.endsWith("$")) {
    return `${symbol}${grouped}`;
  }
  return `${symbol} ${grouped}`;
}

/**
 * Format a deal value as a currency string. Whole-number output
 * (no minor units) — deal values are tracked to whole units across
 * the app. `currency` defaults to INR so callers with nothing better
 * stay safe, but pass the account/deal currency wherever known.
 *
 * Total by design: `Intl.NumberFormat` throws a RangeError on a
 * structurally invalid currency code, and `deals.currency` carries
 * NO DB CHECK (only `accounts.default_currency` does), so legacy
 * rows, imports, or hand-edited data can hold malformed values like
 * "United States". We never let that crash a render — on a bad code
 * we fall back to "CODE 1,234".
 */
export function formatCurrency(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = (currency || DEFAULT_CURRENCY).trim();
  const amount = Number(value) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // Invalid ISO code — show the raw code + grouped number so the
    // value is still legible instead of throwing.
    return `${code} ${new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 0,
    }).format(amount)}`;
  }
}

/**
 * Compact currency for tight spaces (donut center, legend rows):
 * "$1.2M" / "€34.5k" / "₹900". Uses the currency's symbol from
 * CURRENCIES, falling back to the code when we don't carry a symbol.
 */
export function formatCurrencyShort(
  value: number,
  currency: string = DEFAULT_CURRENCY,
): string {
  const code = currency || DEFAULT_CURRENCY;
  const symbol = CURRENCIES.find((c) => c.code === code)?.symbol ?? `${code} `;
  const v = Number(value || 0);
  if (v >= 1_000_000) return `${symbol}${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${symbol}${(v / 1_000).toFixed(1)}k`;
  return `${symbol}${v.toFixed(0)}`;
}
