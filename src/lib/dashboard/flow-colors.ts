// Deterministic flow → color mapping for dashboard charts.
//
// Assignment (see assignFlowColors) is id-hashed: each stable
// flowId hashes (FNV-1a) into the palette, collisions resolve by
// linear probe, so within one rendered view every distinct flow
// gets a UNIQUE color — never two flows sharing a slot. If flows
// outnumber the base palette, extra hues are generated
// deterministically (golden-angle walk, soft enterprise
// saturation/lightness) instead of reusing a color.
//
// Colors are NEVER keyed by flow name: renaming a flow, reordering
// the list, or switching accounts leaves every flowId on the same
// color. Only the stable flowId (or another stable flow key)
// feeds the hash.
//
// Palette is a consistently light/pastel enterprise set (soft
// blue, coral, yellow, green, purple, plus pastel companions).
// Flat fills only — no gradients, no dark/saturated segments —
// tuned for a calm enterprise feel on the white dashboard.
//
// Reserved buckets sit outside the palette: unattributed contacts
// ("No flow") are always neutral gray (#9AA0A6); the grouped
// "Others" bucket is always enterprise dark gray. Neither can
// collide with a real flow, and "No flow" never consumes a palette
// slot.
//
// No existing dashboard color mechanism to reuse (the flow
// breakdown table uses a single blue progress bar), so this
// module is the shared mechanism going forward.

export const NO_FLOW_KEY = '__no_flow__'
export const OTHERS_KEY = '__others__'

export const NO_FLOW_COLOR = '#9AA0A6'
export const OTHERS_COLOR = '#80868B'
export const NO_FLOW_LABEL = 'No flow'
export const OTHERS_LABEL = 'Others'

/**
 * Contacts-by-Ad buckets reuse this same color system (no second
 * palette): ad URLs are hashed ids via assignFlowColors, the grouped
 * remainder reuses the Others slot, and unattributed contacts reuse
 * the neutral gray slot under ad-specific aliases.
 */
export const NO_AD_KEY = '__no_ad__'
export const NO_AD_LABEL = 'No Ad'
export const NO_AD_COLOR = NO_FLOW_COLOR
export const AD_OTHERS_COLOR = OTHERS_COLOR

/** The default non-hovered bar color (matches the classic chart). */
export const SOLID_BAR_COLOR = '#2563eb'

/**
 * Base categorical palette — consistently light/pastel enterprise
 * set. Every entry is a soft pastel tuned for a white/light
 * dashboard: calm, professional, easy on the eyes, and mutually
 * distinguishable. Flat fills only; none is gray so the reserved
 * buckets can never collide with a real flow.
 */
export const FLOW_PALETTE = [
  '#8AB4F8', // soft Google blue
  '#F28B82', // soft coral/red
  '#FDD663', // soft yellow
  '#81C995', // soft green
  '#C58AF9', // soft purple
  '#78D4E8', // soft cyan
  '#FFAB91', // soft peach
  '#A8A7F5', // soft indigo
  '#F48FB1', // soft pink
  '#80CBC4', // soft teal
  '#D6C96A', // soft olive
  '#E7A1B3', // soft rose
] as const

/** FNV-1a 32-bit — tiny, deterministic, no deps. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Deterministic fallback color for ranks beyond the base palette.
 * Golden-angle hue walk (seeded by rank) at pastel enterprise
 * saturation / lightness — light and calm on white like the base
 * palette, never gray, never repeating within any realistic flow
 * count.
 */
export function fallbackFlowColor(rank: number): string {
  const hue = Math.floor((215 + rank * 137.508) % 360)
  return `hsl(${hue}, 55%, 75%)`
}

/**
 * Assign a unique color per flow id. Deterministic for a given id
 * set: primary slot is hash(id) into the palette; hash collisions
 * resolve by linear probe; ranks beyond palette capacity use the
 * fallback generator (skipping hues already taken). Guarantees:
 * no two ids share a color, no id collides with the reserved
 * buckets, and adding a new flow never recolors existing flows
 * unless their probe paths overlap (rare, and still deterministic).
 */
export function assignFlowColors(ids: string[]): Map<string, string> {
  const uniq = [...new Set(ids)].sort()
  const used = new Set<string>([NO_FLOW_COLOR, OTHERS_COLOR])
  const out = new Map<string, string>()
  const pending: string[] = []
  for (const id of uniq) {
    const c = FLOW_PALETTE[hashString(id) % FLOW_PALETTE.length]!
    if (used.has(c)) {
      pending.push(id)
      continue
    }
    used.add(c)
    out.set(id, c)
  }
  for (const id of pending) {
    let i = (hashString(id) + 1) % FLOW_PALETTE.length
    let guard = 0
    while (used.has(FLOW_PALETTE[i]!) && guard < FLOW_PALETTE.length) {
      i = (i + 1) % FLOW_PALETTE.length
      guard += 1
    }
    if (!used.has(FLOW_PALETTE[i]!)) {
      used.add(FLOW_PALETTE[i]!)
      out.set(id, FLOW_PALETTE[i]!)
      continue
    }
    // Palette exhausted — deterministic generated hue, skipping
    // anything already taken (exact-string check).
    let rank = FLOW_PALETTE.length + out.size
    let c = fallbackFlowColor(rank)
    while (used.has(c)) {
      rank += 1
      c = fallbackFlowColor(rank)
    }
    used.add(c)
    out.set(id, c)
  }
  return out
}
