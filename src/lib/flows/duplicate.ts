/**
 * Flow duplication helpers.
 *
 * The copy name generation is kept as a pure function so the route can
 * delegate the "safely avoid a collision" logic and the tests can cover
 * it without spinning up the Supabase mock.
 *
 * Naming rule (matches the product requirement):
 *   "Welcome Flow"          -> "Welcome Flow - Copy"
 *   "Welcome Flow - Copy"   -> "Welcome Flow - Copy 2"
 *   "Welcome Flow - Copy 2" -> "Welcome Flow - Copy 3"
 */

export function uniqueCopyName(
  originalName: string,
  existingNames: string[],
): string {
  const base = `${originalName} - Copy`
  const taken = new Set(existingNames.map((n) => n.trim()))
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base} ${i}`)) i += 1
  return `${base} ${i}`
}
