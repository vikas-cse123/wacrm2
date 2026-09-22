/**
 * "Create a new flow" input routing (Flows page, blank-name field).
 *
 * A trimmed value that is exactly a UUID is treated as a source Flow
 * ID and routed to the copy endpoint; anything else (names, partial
 * UUIDs, random text) is an ordinary blank-flow name. Pure and
 * UI-agnostic so the rule is unit-testable.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NewFlowInput =
  | { kind: "copy"; sourceFlowId: string }
  | { kind: "blank"; name: string };

export function parseNewFlowInput(raw: string): NewFlowInput {
  const trimmed = raw.trim();
  if (UUID_RE.test(trimmed)) {
    return { kind: "copy", sourceFlowId: trimmed };
  }
  return { kind: "blank", name: trimmed };
}
