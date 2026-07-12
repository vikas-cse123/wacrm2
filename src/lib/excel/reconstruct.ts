/**
 * Pure helpers that turn raw flow rows/events into the shape the /excel
 * table needs. No DB, no I/O — unit-testable under the node test env.
 *
 * Data sources (all already produced by the flow engine — no schema
 * changes):
 *   • Questions come from the node config: send_buttons/send_list use
 *     `config.text`, collect_input uses `config.prompt_text`.
 *   • Button/list answers map the tapped `reply_id` (recorded on the
 *     `reply_received` event) back to its `title` via the node config.
 *   • collect_input answers are the captured value in `flow_runs.vars`.
 *   • Completion is either "reached a configured node" (a `node_entered`
 *     event for it) or the run's natural 'completed' status.
 */

import type { TrackedFlow } from "./tracked-flows";

export interface FlowNodeLite {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export interface FlowRunEventLite {
  event_type: string;
  node_key: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface FlowRunLite {
  id: string;
  flow_id: string;
  status: string;
  vars: Record<string, unknown> | null;
  started_at: string;
  ended_at: string | null;
  current_node_key: string | null;
}

/** Node types that ask the customer something (i.e. expect a reply). */
const QUESTION_NODE_TYPES = new Set([
  "send_buttons",
  "send_list",
  "collect_input",
]);

export function isQuestionNode(nodeType: string): boolean {
  return QUESTION_NODE_TYPES.has(nodeType);
}

/**
 * Normalizes question text for fuzzy matching: lowercase, strip emoji /
 * markdown / punctuation, collapse whitespace. So "👋 *May I know your
 * Full Name?*" and "may i know your full name" compare equal.
 */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finds the node_key of the question node whose prompt best matches the
 * given text (exact-normalized first, then substring either direction).
 * Returns null when nothing matches.
 */
export function findNodeKeyByQuestion(
  nodes: Iterable<FlowNodeLite>,
  text: string,
): string | null {
  const target = normalizeQuestion(text);
  if (!target) return null;
  let substringHit: string | null = null;
  for (const node of nodes) {
    if (!isQuestionNode(node.node_type)) continue;
    const q = questionText(node);
    if (!q) continue;
    const nq = normalizeQuestion(q);
    if (nq === target) return node.node_key; // exact wins immediately
    if (!substringHit && (nq.includes(target) || target.includes(nq))) {
      substringHit = node.node_key;
    }
  }
  return substringHit;
}

/** The prompt text for a question node, or null if it isn't one. */
export function questionText(node: FlowNodeLite): string | null {
  const cfg = node.config ?? {};
  if (node.node_type === "collect_input") {
    return typeof cfg.prompt_text === "string" ? cfg.prompt_text : null;
  }
  if (node.node_type === "send_buttons" || node.node_type === "send_list") {
    return typeof cfg.text === "string" ? cfg.text : null;
  }
  return null;
}

/**
 * Maps a tapped reply_id back to its human label via the node config.
 * Works for both send_buttons (`buttons[]`) and send_list (`sections[].rows[]`).
 */
export function buttonTitleForReplyId(
  node: FlowNodeLite,
  replyId: string,
): string | null {
  const cfg = node.config ?? {};
  if (node.node_type === "send_buttons") {
    const buttons = Array.isArray(cfg.buttons) ? cfg.buttons : [];
    for (const b of buttons) {
      if (b && typeof b === "object" && (b as Record<string, unknown>).reply_id === replyId) {
        const title = (b as Record<string, unknown>).title;
        return typeof title === "string" ? title : null;
      }
    }
  }
  if (node.node_type === "send_list") {
    const sections = Array.isArray(cfg.sections) ? cfg.sections : [];
    for (const section of sections) {
      const rows = Array.isArray((section as Record<string, unknown>)?.rows)
        ? ((section as Record<string, unknown>).rows as unknown[])
        : [];
      for (const r of rows) {
        if (r && typeof r === "object" && (r as Record<string, unknown>).reply_id === replyId) {
          const title = (r as Record<string, unknown>).title;
          return typeof title === "string" ? title : null;
        }
      }
    }
  }
  return null;
}

/**
 * Whether a run satisfies the /excel completion criteria:
 *   • custom completion node configured → the run reached that node
 *     (a `node_entered` event exists for it, or it's the current node).
 *   • otherwise → the run's status is 'completed'.
 */
export function isRunComplete(
  run: FlowRunLite,
  events: FlowRunEventLite[],
  tracked: TrackedFlow,
): boolean {
  if (tracked.completionNodeKey) {
    if (run.current_node_key === tracked.completionNodeKey) return true;
    return events.some(
      (e) =>
        e.node_key === tracked.completionNodeKey &&
        e.event_type === "node_entered",
    );
  }
  // Default (no custom node): any run that is no longer running counts —
  // completed, handed_off, timed_out, failed, paused_by_agent. This
  // surfaces all previously-ended runs, not just the 'completed' ones.
  return run.status !== "active";
}

/**
 * The moment a run counts as complete:
 *   • custom node → the timestamp it first entered that node.
 *   • otherwise → the run's ended_at.
 * Falls back to null when unknown.
 */
export function completionTime(
  run: FlowRunLite,
  events: FlowRunEventLite[],
  tracked: TrackedFlow,
): string | null {
  if (tracked.completionNodeKey) {
    const entered = events
      .filter(
        (e) =>
          e.node_key === tracked.completionNodeKey &&
          e.event_type === "node_entered",
      )
      .map((e) => e.created_at)
      .sort();
    return entered[0] ?? run.ended_at ?? null;
  }
  // Prefer the recorded end time; fall back to the last event, then the
  // start, so ended runs that never stamped ended_at still show a time.
  if (run.ended_at) return run.ended_at;
  const lastEvent = events
    .map((e) => e.created_at)
    .sort()
    .at(-1);
  return lastEvent ?? run.started_at ?? null;
}

export interface QAEntry {
  question: string;
  answer: string | null;
}

export interface RunQA {
  /** Question node keys in the order they were first asked. */
  order: string[];
  /** node_key → { question, answer }. */
  byNode: Record<string, QAEntry>;
}

/**
 * Rebuilds the question/answer pairs for one run from its events + the
 * flow's nodes + the run's captured vars.
 */
export function reconstructRunQA(
  run: FlowRunLite,
  nodesByKey: Map<string, FlowNodeLite>,
  events: FlowRunEventLite[],
): RunQA {
  const order: string[] = [];
  const seen = new Set<string>();
  const byNode: Record<string, QAEntry> = {};
  const vars = run.vars ?? {};

  // Chronological so first-asked ordering is stable.
  const ordered = [...events].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );

  const ensure = (nodeKey: string, node: FlowNodeLite) => {
    if (!seen.has(nodeKey)) {
      seen.add(nodeKey);
      order.push(nodeKey);
      byNode[nodeKey] = {
        question: questionText(node) ?? nodeKey,
        answer: null,
      };
    }
  };

  for (const ev of ordered) {
    if (!ev.node_key) continue;
    const node = nodesByKey.get(ev.node_key);
    if (!node || !isQuestionNode(node.node_type)) continue;

    if (ev.event_type === "message_sent") {
      // The question was asked here.
      ensure(ev.node_key, node);
    } else if (ev.event_type === "reply_received") {
      ensure(ev.node_key, node);
      let answer: string | null = null;
      if (node.node_type === "collect_input") {
        const varKey = (node.config?.var_key as string) ?? "";
        const v = varKey ? vars[varKey] : undefined;
        answer = v == null ? null : String(v);
      } else {
        const replyId = (ev.payload?.reply_id as string) ?? "";
        answer = replyId ? buttonTitleForReplyId(node, replyId) : null;
      }
      // Last answer wins (handles reprompts / re-visits).
      if (answer != null) byNode[ev.node_key].answer = answer;
    }
  }

  return { order, byNode };
}
