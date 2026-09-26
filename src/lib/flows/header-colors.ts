// ============================================================
// Workspace header colors — pure model (no React, no I/O).
//
// EXACT reference palette (never approximated):
//   #93c47d  default / remaining business column (green)
//   #6d9eeb  Phone Number (blue)
//   #ff9900  Name (orange)
//   #46bdc6  Follow-Up Status / Follow Up (teal)
//   #34a853  Final Remark (green)
//   #ea4335  Reason for Lost Lead (red)
//
// Plus one fixed semantic:
//   #f1f5f9  Row-number ("No.") column
//
// Resolution per visible set (deterministic, stable):
//   1. stored custom overrides win first (first-wins in
//      visible order — the API rejects duplicate customs with
//      409 and the picker blocks them, so first-wins is pure
//      defense);
//   2. semantic palette matches (phone/name/follow-up/remark/
//      lost) when the color is still free;
//   3. UNUSED palette colors are reassigned, in palette order,
//      to the remaining columns in visible order — so a mapped
//      color never disappears just because its column is absent
//      from this flow (e.g. no "Reason for Lost Lead" column:
//      #ea4335 still paints another visible column);
//   4. beyond six non-custom columns, a deterministic generated
//      ring supplies overflow hues (columns outnumber palette
//      slots; uniqueness is preserved, no randomness).
//
// Appending a column never changes an earlier column's color;
// customs never move; the same (visId, label) always resolves
// the same default.
//
// Text contrast (WCAG): the header text color is picked per
// background by contrast ratio — dark slate on light
// backgrounds, white on dark ones (e.g. #ea4335) — so
// readability never depends on the background. Backgrounds are
// flat fills only: no gradients, no heavy borders. Color is
// decorative only; labels and structure carry all information.
//
// No member names, emails, UUIDs, or roles are hardcoded here.
// ============================================================

/** Dark slate header text for light backgrounds. */
export const HEADER_TEXT_DARK = "#1e293b";
/** White header text for dark custom backgrounds. */
export const HEADER_TEXT_LIGHT = "#ffffff";

/**
 * Exact reference palette, in sequential fallback order. Lowercase
 * #rrggbb — the ONLY backgrounds the default assignment may use.
 */
export const HEADER_REFERENCE_PALETTE: readonly string[] = [
  "#93c47d", // default / remaining business column
  "#6d9eeb", // Phone Number
  "#ff9900", // Name
  "#46bdc6", // Follow-Up Status / Follow Up
  "#34a853", // Final Remark
  "#ea4335", // Reason for Lost Lead
];

/** Default / remaining business column background. */
export const HEADER_REFERENCE_DEFAULT = "#93c47d";
/** Row-number ("No.") column background. */
export const HEADER_REFERENCE_ROW = "#f1f5f9";
/** Phone Number column background. */
export const HEADER_REFERENCE_PHONE = "#6d9eeb";
/** Name column background. */
export const HEADER_REFERENCE_NAME = "#ff9900";
/** Follow-Up Status / Follow Up column background. */
export const HEADER_REFERENCE_FOLLOW_UP = "#46bdc6";
/** Final Remark column background. */
export const HEADER_REFERENCE_FINAL_REMARK = "#34a853";
/** Reason for Lost Lead column background. */
export const HEADER_REFERENCE_LOST_REASON = "#ea4335";

/** hsl(degrees, %, %) → lowercase #rrggbb. */
function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) =>
    light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

/**
 * Fallback pastel ring for dynamic columns (flow answers, new
 * custom fields): 24 golden-angle hues at fixed pastel
 * saturation/lightness — distinct from each other and from
 * every curated default by construction (test-verified).
 */
export const HEADER_FALLBACK_PALETTE: readonly string[] = Array.from(
  { length: 24 },
  (_, i) => hslToHex(i * 137.5, 62, 87),
);

/** Full pool: reference palette first, generated ring after. */
export const HEADER_COLOR_POOL: readonly string[] = [
  ...HEADER_REFERENCE_PALETTE,
  ...HEADER_FALLBACK_PALETTE,
];

/**
 * Beyond-pool overflow (pathological 40+ column tables):
 * continued golden-angle hues at a deeper lightness — still
 * deterministic hex, still probed for freeness by the builder.
 */
export function overflowHeaderColor(n: number): string {
  return hslToHex(n * 137.5 + 31, 62, 82);
}

/**
 * Preset swatches offered in the picker: exactly the reference
 * palette. Arbitrary (incl. dark) colors remain available via
 * the custom native color input, with auto text contrast.
 */
export const HEADER_COLOR_PRESETS: readonly string[] = [
  ...HEADER_REFERENCE_PALETTE,
];

/** Every reference color, exported for the pairwise-uniqueness test. */
export const HEADER_CURATED_DEFAULTS: readonly string[] = [
  ...HEADER_REFERENCE_PALETTE,
];

/** djb2 — deterministic, no dependencies. */
function hashString(value: string): number {
  let h = 5381;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Semantic reference color for a column, or null when the column
 * carries no mapped meaning. Matching is case-insensitive on the
 * trimmed label, plus the two stable flow field ids:
 *   - Phone Number ("Phone No", "Phone Number", …) → blue
 *   - Name → orange
 *   - Follow-Up Status / Follow Up (exactly the status field —
 *     NOT "Next Follow-up Date & Time") → teal
 *   - Final Remark → green
 *   - Reason for Lost Lead / Reason of Lost → red
 */
function semanticReferenceColor(visId: string, label: string): string | null {
  if (visId === "core:row") return HEADER_REFERENCE_ROW;
  if (visId === "flow:phone") return HEADER_REFERENCE_PHONE;
  if (visId === "flow:name") return HEADER_REFERENCE_NAME;
  const name = typeof label === "string" ? label.trim().toLowerCase() : "";
  if (name === "row") return HEADER_REFERENCE_ROW;
  if (name.includes("phone")) return HEADER_REFERENCE_PHONE;
  if (name === "name") return HEADER_REFERENCE_NAME;
  if (
    name === "follow up" ||
    name.includes("follow-up status") ||
    name.includes("follow up status")
  ) {
    return HEADER_REFERENCE_FOLLOW_UP;
  }
  if (name.includes("final remark")) return HEADER_REFERENCE_FINAL_REMARK;
  if (
    name.includes("reason for lost lead") ||
    name.includes("reason of lost")
  ) {
    return HEADER_REFERENCE_LOST_REASON;
  }
  return null;
}

/** Fixed preferred default: semantic match, else the default green. */
function preferredDefaultColor(visId: string, label: string): string {
  return semanticReferenceColor(visId, label) ?? HEADER_REFERENCE_DEFAULT;
}

/**
 * Default header background for one column. Pure + stable:
 * same (visId, label) always yields the same color — the
 * semantic reference color when the column carries mapped
 * meaning, else the default green. NOTE: set-wide palette
 * reuse (unused mapped colors reassigned to visible columns)
 * lives in buildHeaderColorMap — this single-column form cannot
 * see its neighbours (kept for previews/fallbacks).
 */
export function defaultHeaderColor(visId: string, label: string): string {
  return preferredDefaultColor(visId, label);
}

export interface HeaderColumnRef {
  visId: string;
  label: string;
}

/**
 * Effective header backgrounds for a visible column set:
 *
 *   1. valid stored customs, first-wins in visible order
 *      (a duplicated custom — only possible via a raced write
 *      the API now rejects — falls back to a free default);
 *   2. semantic reference colors for mapped columns, when free;
 *   3. UNUSED reference palette colors, in palette order,
 *      assigned to the remaining columns in visible order — a
 *      mapped color never disappears just because its column is
 *      absent from this flow;
 *   4. beyond the six palette slots, the deterministic
 *      generated ring, then overflow hues.
 *
 * Deterministic: same visible set (+ customs) always yields the
 * same map. Appending a column never changes an earlier fixed
 * column's color; customs never move.
 */
export function buildHeaderColorMap(
  columns: ReadonlyArray<HeaderColumnRef>,
  customs?: Readonly<Record<string, string>> | null,
): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<string>();

  const take = (visId: string, hex: string): void => {
    map[visId] = hex;
    used.add(hex);
  };

  // Pass 1 — customs, first-wins.
  const needy: number[] = [];
  columns.forEach((col, i) => {
    const raw = customs?.[col.visId];
    if (typeof raw === "string" && raw.trim() !== "") {
      try {
        const hex = normalizeHeaderColor(raw);
        if (!used.has(hex)) {
          take(col.visId, hex);
          return;
        }
      } catch {
        // Invalid stored value → default path below.
      }
    }
    needy.push(i);
  });

  // Pass 2 — semantic reference colors, when still free.
  const stillNeedy: number[] = [];
  for (const i of needy) {
    const pref = semanticReferenceColor(columns[i].visId, columns[i].label);
    if (pref !== null && !used.has(pref)) {
      take(columns[i].visId, pref);
    } else {
      stillNeedy.push(i);
    }
  }

  // Pass 3 — unused palette colors in palette order, assigned in
  // visible order; then the generated ring; then overflow hues.
  for (const i of stillNeedy) {
    const col = columns[i];
    let pick: string | null = null;
    for (const cand of HEADER_REFERENCE_PALETTE) {
      if (!used.has(cand)) {
        pick = cand;
        break;
      }
    }
    if (pick === null) {
      const start = hashString(col.visId) % HEADER_COLOR_POOL.length;
      for (let k = 0; k < HEADER_COLOR_POOL.length; k++) {
        const cand = HEADER_COLOR_POOL[(start + k) % HEADER_COLOR_POOL.length];
        if (!used.has(cand)) {
          pick = cand;
          break;
        }
      }
    }
    let n = 0;
    while (pick === null && n < 500) {
      const cand = overflowHeaderColor(n);
      n += 1;
      if (!used.has(cand)) pick = cand;
    }
    // Unreachable in practice (500 overflow hues); last resort
    // keeps the map total rather than dropping the column.
    take(col.visId, pick ?? overflowHeaderColor(n));
  }

  return map;
}

/**
 * Normalize a color to lowercase #rrggbb. Accepts #rgb / #rrggbb
 * (any case, surrounding whitespace tolerated). Throws on
 * anything else — the API and the picker share this gate.
 */
export function normalizeHeaderColor(value: unknown): string {
  if (typeof value !== "string") throw new Error("Color must be a hex value.");
  const trimmed = value.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(trimmed);
  if (short) {
    const [r, g, b] = short[1];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  throw new Error("Color must be a hex value like #6d9eeb.");
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Readable header text for a background: whichever of dark slate
 * / white contrasts more (WCAG ratio). Pastels → dark slate; a
 * dark custom pick → white, automatically.
 */
export function headerTextColor(background: string): string {
  let bg = HEADER_TEXT_DARK;
  try {
    bg = normalizeHeaderColor(background);
  } catch {
    return HEADER_TEXT_DARK;
  }
  const lum = relativeLuminance(bg);
  const dark = contrastRatio(lum, relativeLuminance(HEADER_TEXT_DARK));
  const light = contrastRatio(lum, relativeLuminance(HEADER_TEXT_LIGHT));
  return light > dark ? HEADER_TEXT_LIGHT : HEADER_TEXT_DARK;
}

/** True when the background takes the dark (white-text) path. */
export function isDarkHeaderColor(background: string): boolean {
  return headerTextColor(background) === HEADER_TEXT_LIGHT;
}

/**
 * Effective header background for ONE column: the stored custom
 * override when present and valid, else the default. (Set-wide
 * uniqueness lives in buildHeaderColorMap; this stays for
 * single-cell previews such as the manager dots.)
 */
export function resolveHeaderColor(
  visId: string,
  label: string,
  customs: Readonly<Record<string, string>> | null | undefined,
): string {
  const raw = customs?.[visId];
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      return normalizeHeaderColor(raw);
    } catch {
      // Corrupt stored value degrades to the default — never blank.
    }
  }
  return defaultHeaderColor(visId, label);
}
