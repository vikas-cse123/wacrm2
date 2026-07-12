/**
 * ============================================================
 * /excel — tracked-flow configuration (EDIT THIS FILE)
 * ============================================================
 *
 * This is the single place to control which flows show up on the
 * /excel page and when a run counts as "complete". No UI, no database
 * changes — add or remove an entry here and redeploy.
 *
 * How to fill an entry:
 *   • flowId — open the flow in the builder; the id is the UUID in the
 *     URL: /flows/<flowId>. Only runs of these flows appear on /excel.
 *   • completionNodeKey (optional) — treat a run as complete the moment
 *     it REACHES this node, even if the flow continues afterwards. The
 *     node_key is shown in the builder on each node card (e.g.
 *     "send_buttons_6" under the node title). Omit it to fall back to
 *     the flow's natural 'completed' status.
 *   • label (optional) — display name override for the Flow column.
 *     Defaults to the flow's real name.
 *
 * Example — Singapore Chat Automation counts as complete as soon as the
 * customer reaches the "How many nights are you planning to stay?" node:
 *
 *   {
 *     flowId: "00000000-0000-0000-0000-000000000000",
 *     completionNodeKey: "send_buttons_6",
 *   }
 */

export interface TrackedFlow {
  /** flows.id — the UUID from the /flows/<flowId> builder URL. */
  flowId: string;
  /**
   * When set, a run is "complete" once it reaches this node_key (a
   * node_entered event exists for it). When omitted, completion falls
   * back to the run's natural 'completed' status.
   */
  completionNodeKey?: string;
  /** Optional display name for the Flow column (defaults to flow name). */
  label?: string;
}

export const TRACKED_FLOWS: TrackedFlow[] = [
  // Add your flows here. Example (replace with a real flow id):
  // {
  //   flowId: "00000000-0000-0000-0000-000000000000",
  //   completionNodeKey: "send_buttons_6",
  //   label: "Singapore Chat Automation",
  // },
];

/** Flow ids to include — derived, so the query layer never re-lists them. */
export const TRACKED_FLOW_IDS: string[] = TRACKED_FLOWS.map((f) => f.flowId);

/** Look up the config for a flow id (undefined when not tracked). */
export function getTrackedFlow(flowId: string): TrackedFlow | undefined {
  return TRACKED_FLOWS.find((f) => f.flowId === flowId);
}
