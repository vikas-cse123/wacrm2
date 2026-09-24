// ============================================================
// Workspace header colors — pure model (no React, no I/O).
//
// STRICT RULE: every visible column gets its OWN header
// background — never the same color twice. Uniqueness is
// enforced set-aware by buildHeaderColorMap (one pass over the
// visible columns): stored customs win first (first-wins in
// visible order), then fixed preferred defaults, then a probe
// over the shared pool. A duplicate custom can only arrive via
// a raced write — the API rejects those with 409 and the picker
// blocks them with an explicit message, so the resolver's
// first-wins fallback is pure defense.
//
// Default resolution per column (stable across hide/show and
// reload — fixed identities never depend on the visible set):
//   1. known visibility id  → curated pastel (core + lead source)
//   2. known business name  → curated pastel (the 12 default
//      Workspace columns, matched case-insensitively by label)
//   3. otherwise            → deterministic hash pick from the
//      fallback pastel ring (dynamic flow answers, new custom
//      fields — no per-column hardcoding)
//
// All 17 curated defaults are pairwise distinct, and every
// fallback entry is generated (golden-angle hues at fixed
// pastel saturation/lightness) to collide with nothing —
// verified by test, not by eyeballing.
//
// Text contrast (WCAG): the header text color is picked per
// background by contrast ratio — dark slate on pastels, white
// on dark custom picks — so readability never depends on the
// user choosing "correctly". Color is decorative only; labels
// and structure carry all information.
//
// No member names, emails, UUIDs, or roles are hardcoded here.
// ============================================================

/** Dark slate header text for light backgrounds. */
export const HEADER_TEXT_DARK = "#1e293b";
/** White header text for dark custom backgrounds. */
export const HEADER_TEXT_LIGHT = "#ffffff";

/** Curated defaults for stable visibility ids (core + lead source). */
const KNOWN_VIS_ID_DEFAULTS: Readonly<Record<string, string>> = {
  "core:row": "#f1f5f9",
  "flow:submission_time": "#e0f2fe",
  "flow:name": "#fef9c3",
  "flow:phone": "#fce7f3",
  lead_source: "#ccfbf1",
};

/** Curated defaults for the 12 default business columns (by lowercase label). */
const KNOWN_NAME_DEFAULTS: Readonly<Record<string, string>> = {
  "assigned to": "#dbeafe",
  "call status": "#dcfce7",
  "no. of calls tried": "#fde68a",
  "lead quality": "#f3e8ff",
  "quotation / package": "#ffedd5",
  "follow-up status": "#fbcfe8",
  "last contact date": "#cffafe",
  "customer response": "#ede9fe",
  "next follow-up date & time": "#fef3c7",
  "next action": "#d1fae5",
  "reason for lost lead": "#ffe4e6",
  "final remark": "#ecfccb",
};

/** Every curated default, exported for the pairwise-uniqueness test. */
export const HEADER_CURATED_DEFAULTS: readonly string[] = [
  ...Object.values(KNOWN_VIS_ID_DEFAULTS),
  ...Object.values(KNOWN_NAME_DEFAULTS),
];

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

/** Full strict-uniqueness pool: curated first, fallback after. */
export const HEADER_COLOR_POOL: readonly string[] = [
  ...HEADER_CURATED_DEFAULTS,
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
 * Preset swatches offered in the picker. Light/enterprise only —
 * arbitrary (incl. dark) colors remain available via the custom
 * native color input, with auto text contrast.
 */
export const HEADER_COLOR_PRESETS: readonly string[] = [
  "#dbeafe",
  "#dcfce7",
  "#fde68a",
  "#f3e8ff",
  "#ffedd5",
  "#fbcfe8",
  "#cffafe",
  "#ede9fe",
  "#fef3c7",
  "#d1fae5",
  "#ffe4e6",
  "#ecfccb",
];

/** djb2 — deterministic, no dependencies. */
function hashString(value: string): number {
  let h = 5381;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Fixed preferred default, or null for dynamic columns. */
function preferredDefaultColor(visId: string, label: string): string | null {
  const known = KNOWN_VIS_ID_DEFAULTS[visId];
  if (known) return known;
  const byName =
    KNOWN_NAME_DEFAULTS[typeof label === "string" ? label.trim().toLowerCase() : ""];
  return byName ?? null;
}

/**
 * Default header background for one column. Pure + stable:
 * same (visId, label) always yields the same color. NOTE: for
 * the strict no-duplicates guarantee across a visible set, use
 * buildHeaderColorMap — this single-column form cannot see its
 * neighbours (kept for previews/fallbacks).
 */
export function defaultHeaderColor(visId: string, label: string): string {
  return (
    preferredDefaultColor(visId, label) ??
    HEADER_FALLBACK_PALETTE[hashString(visId) % HEADER_FALLBACK_PALETTE.length]
  );
}

export interface HeaderColumnRef {
  visId: string;
  label: string;
}

/**
 * Effective header backgrounds for a visible column set — EVERY
 * value unique, guaranteed while the pool covers the set (41
 * slots) and probed overflow beyond that:
 *
 *   1. valid stored customs, first-wins in visible order
 *      (a duplicated custom — only possible via a raced write
 *      the API now rejects — falls back to a free default);
 *   2. fixed preferred defaults for known columns, when free;
 *   3. pool probe from a hash start, then overflow hues.
 *
 * Appending a column never changes an earlier fixed column's
 * color; customs never move.
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

  // Pass 2 — fixed preferred defaults, when still free.
  const stillNeedy: number[] = [];
  for (const i of needy) {
    const pref = preferredDefaultColor(columns[i].visId, columns[i].label);
    if (pref !== null && !used.has(pref)) {
      take(columns[i].visId, pref);
    } else {
      stillNeedy.push(i);
    }
  }

  // Pass 3 — pool probe from a hash start, overflow beyond that.
  for (const i of stillNeedy) {
    const col = columns[i];
    const start = hashString(col.visId) % HEADER_COLOR_POOL.length;
    let pick: string | null = null;
    for (let k = 0; k < HEADER_COLOR_POOL.length; k++) {
      const cand = HEADER_COLOR_POOL[(start + k) % HEADER_COLOR_POOL.length];
      if (!used.has(cand)) {
        pick = cand;
        break;
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
  throw new Error("Color must be a hex value like #dbeafe.");
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
