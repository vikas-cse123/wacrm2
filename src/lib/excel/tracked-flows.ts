/**
 * ============================================================
 * /excel — tracked-flow configuration (EDIT THIS FILE)
 * ============================================================
 *
 * The single place that controls which flows appear on /excel, when a
 * run counts as "complete", and which question columns to show. No UI,
 * no database changes — edit and redeploy.
 *
 * Identify a flow by EITHER:
 *   • flowName — the flow's exact name (case-insensitive), or
 *   • flowId   — the UUID from the /flows/<flowId> builder URL.
 *
 * Completion (pick one, else falls back to "run has ended"):
 *   • completeWhenReached — the QUESTION TEXT of the node that marks
 *     completion; a run counts as complete the moment it reaches it,
 *     even if it's still running. Only completers appear.
 *   • completionNodeKey — same idea, but by the raw node_key.
 *
 * Columns:
 *   • columns — an ordered list of QUESTION TEXTS. When set, ONLY these
 *     columns appear (in this order). Matching is fuzzy (case/emoji/
 *     markdown-insensitive), so paste the questions roughly as authored.
 *     Omit to auto-derive every question the run answered.
 *
 * When TRACKED_FLOWS is empty, /excel shows every flow + every ended run
 * (exploratory mode).
 */

export interface TrackedFlow {
  flowId?: string;
  flowName?: string;
  label?: string;
  completionNodeKey?: string;
  completeWhenReached?: string;
  columns?: string[];
}

export const TRACKED_FLOWS: TrackedFlow[] = [
  {
    flowName: "Singapore Chat Automation",
    // A run counts as complete once it reaches the "How many nights"
    // question — so only people who got that far show up.
    completeWhenReached: "How many nights are you planning to stay?",
    // Only these columns, in this order.
    columns: [
      "May I know your Full Name?",
      "Do you have a passport with at least 6 months of validity?",
      "Which hotel category would you prefer?",
      "When are you planning to travel?",
      "Which city will you travel from?",
      "Do you have any special requests?",
      "How many nights are you planning to stay?",
    ],
  },
];

/** Whether any flow is explicitly tracked (vs. exploratory all-flows mode). */
export const HAS_TRACKED_FLOWS = TRACKED_FLOWS.length > 0;

/** Match a resolved flow (id + name) to its config entry, if any. */
export function matchTrackedFlow(
  flow: { id: string; name: string | null },
): TrackedFlow | undefined {
  return TRACKED_FLOWS.find((t) => {
    if (t.flowId && t.flowId === flow.id) return true;
    if (
      t.flowName &&
      flow.name &&
      t.flowName.trim().toLowerCase() === flow.name.trim().toLowerCase()
    ) {
      return true;
    }
    return false;
  });
}
