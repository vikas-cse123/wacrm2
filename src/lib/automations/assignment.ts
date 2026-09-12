import type { AssignPerson } from '@/types'

/**
 * Automation-specific assignment — lightweight people belonging to one
 * automation only (NOT CRM users/agents, no login, no roles).
 *
 * Header written to sheets for the selected person's name.
 */
export const ASSIGN_HEADER = 'Assign'
/**
 * Internal answer-column key for the Assign value. Prefixed so it can
 * never collide with a user-authored flow var_key / node_key.
 */
export const ASSIGN_KEY = '__assign'
/**
 * Internal answer-column key for the hidden Flow Run ID on Completed
 * sheets (Assign-enabled only). Gives already-synced Completed rows an
 * exact update identity (same header string as incomplete sheets).
 */
export const COMPLETED_RUN_ID_KEY = '__run_id'
export const COMPLETED_RUN_ID_HEADER = 'Flow Run ID'

export interface AssignmentPickRow {
  id: string
  automation_id: string
  account_id: string
  contact_id: string | null
  flow_run_id: string | null
  log_id: string | null
  step_key: string
  person_name: string
  person_index: number
  percentage: number
  message: string
  /** 'text' = WhatsApp text; 'image' = image with caption. Defaults 'text'. */
  message_type: string
  /** Public image URL Meta fetches. Set only when message_type is 'image'. */
  media_url: string | null
  tag_id: string | null
  created_at: string
}

interface DbLike {
  from(table: string): any
}

/**
 * Runtime validation (defense in depth — activation validation in
 * validate.ts catches these at save time; the engine re-checks so a
 * hand-edited step_config can never produce a silent wrong pick).
 * Throws on invalid config.
 */
export function normalizePersons(raw: unknown): AssignPerson[] {
  const persons = (raw as { persons?: unknown })?.persons ?? raw
  if (!Array.isArray(persons) || persons.length === 0) {
    throw new Error('assign_person needs at least one person')
  }
  const seen = new Set<string>()
  let total = 0
  const out: AssignPerson[] = persons.map((p, i) => {
    const name = typeof (p as AssignPerson)?.name === 'string' ? (p as AssignPerson).name.trim() : ''
    const percentage = Number((p as AssignPerson)?.percentage)
    const rawType = (p as AssignPerson)?.message_type
    // Absent = 'text' (configs saved before message types existed).
    const message_type: 'text' | 'image' = rawType === 'image' ? 'image' : 'text'
    const message = typeof (p as AssignPerson)?.message === 'string' ? (p as AssignPerson).message : ''
    const media_url =
      typeof (p as AssignPerson)?.media_url === 'string' ? (p as AssignPerson).media_url!.trim() : ''
    const tag_id = typeof (p as AssignPerson)?.tag_id === 'string' ? (p as AssignPerson).tag_id.trim() : ''
    if (!name) throw new Error(`assign_person person ${i + 1} needs a name`)
    const lower = name.toLowerCase()
    if (seen.has(lower)) throw new Error(`assign_person names must be unique (${name})`)
    seen.add(lower)
    if (!Number.isFinite(percentage) || percentage <= 0) {
      throw new Error(`assign_person person ${i + 1} needs percentage > 0`)
    }
    total += percentage
    if (!message.trim()) throw new Error(`assign_person person ${i + 1} needs a message`)
    if (message_type === 'image' && !media_url) {
      throw new Error(`assign_person person ${i + 1} needs an image when message type is image`)
    }
    if (!tag_id) throw new Error(`assign_person person ${i + 1} needs a tag`)
    return { name, percentage, message_type, message, media_url, tag_id }
  })
  if (Math.abs(total - 100) > 0.001) {
    throw new Error(`assign_person percentages must total 100 (currently ${total})`)
  }
  return out
}

/**
 * Weighted random index. Randomness happens ONCE per execution — the
 * caller persists the result via claimAssignmentPick so retries reuse
 * the stored winner instead of re-drawing.
 */
export function pickWeightedIndex(
  persons: AssignPerson[],
  rand: () => number = Math.random,
): number {
  const total = persons.reduce((s, p) => s + Number(p.percentage), 0)
  let r = rand() * total
  for (let i = 0; i < persons.length; i += 1) {
    r -= Number(persons[i]!.percentage)
    if (r < 0) return i
  }
  return persons.length - 1
}

/**
 * Durable claim: exactly one pick per (automation_id, log_id, step_key).
 * Read-before-write for retries; INSERT ... ON CONFLICT DO NOTHING for
 * concurrent workers (loser re-reads the winner). Never throws for a
 * conflict — always converges on the stored row.
 */
export async function claimAssignmentPick(
  db: DbLike,
  args: {
    automationId: string
    accountId: string
    contactId: string | null
    flowRunId: string | null
    logId: string | null
    stepKey: string
    persons: AssignPerson[]
    rand?: () => number
  },
): Promise<AssignmentPickRow> {
  // Retry fast-path: an existing pick for this execution wins.
  if (args.logId) {
    const { data: existing } = await db
      .from('automation_assignment_picks')
      .select('*')
      .eq('automation_id', args.automationId)
      .eq('log_id', args.logId)
      .eq('step_key', args.stepKey)
      .maybeSingle()
    if (existing) return existing as AssignmentPickRow
  }

  const index = pickWeightedIndex(args.persons, args.rand ?? Math.random)
  const person = args.persons[index]!

  // Degraded mode (no log row — should not happen in practice):
  // return a transient pick so the send can still proceed; without a
  // log_id there is no unique key to dedupe retries against.
  if (!args.logId) {
    return {
      id: `transient-${Date.now()}`,
      automation_id: args.automationId,
      account_id: args.accountId,
      contact_id: args.contactId,
      flow_run_id: args.flowRunId,
      log_id: null,
      step_key: args.stepKey,
      person_name: person.name,
      person_index: index,
      percentage: Number(person.percentage),
      message: person.message,
      message_type: person.message_type ?? 'text',
      media_url: person.media_url ?? null,
      tag_id: person.tag_id,
      created_at: new Date().toISOString(),
    }
  }

  const payload = {
    automation_id: args.automationId,
    account_id: args.accountId,
    contact_id: args.contactId,
    flow_run_id: args.flowRunId,
    log_id: args.logId,
    step_key: args.stepKey,
    person_name: person.name,
    person_index: index,
    percentage: Number(person.percentage),
    message: person.message,
    message_type: person.message_type ?? 'text',
    media_url: person.media_url ?? null,
    tag_id: person.tag_id,
  }
  // Atomic converge: winner inserts, loser hits the unique constraint
  // and falls through to the re-read below.
  await db
    .from('automation_assignment_picks')
    .upsert(payload, { onConflict: 'automation_id,log_id,step_key', ignoreDuplicates: true })

  const { data: winner } = await db
    .from('automation_assignment_picks')
    .select('*')
    .eq('automation_id', args.automationId)
    .eq('log_id', args.logId)
    .eq('step_key', args.stepKey)
    .maybeSingle()
  if (winner) return winner as AssignmentPickRow
  // Extremely defensive: if the mock/DB returned nothing, fall back to
  // the just-computed person rather than failing the send.
  return {
    id: `fallback-${Date.now()}`,
    ...payload,
    created_at: new Date().toISOString(),
  }
}

/**
 * Sheets resolver — exact flow_run_id only. Never phone/contact/latest.
 * Last-successful-assignment wins when multiple automations/steps wrote
 * picks for the SAME run (documented deterministic rule; no name merging).
 */
export async function getAssignForFlowRun(
  db: DbLike,
  flowRunId: string | null | undefined,
): Promise<string | null> {
  if (!flowRunId) return null
  const map = await getAssignsForFlowRuns(db, [flowRunId])
  return map.get(flowRunId) ?? null
}

/**
 * Batch resolver for sync paths (one indexed query for N runs).
 * Returns runId → person_name for runs with a pick; absent = no pick.
 */
export async function getAssignsForFlowRuns(
  db: DbLike,
  flowRunIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(flowRunIds.filter(Boolean))]
  if (ids.length === 0) return out
  const { data } = await db
    .from('automation_assignment_picks')
    .select('flow_run_id, person_name, created_at')
    .in('flow_run_id', ids)
    .order('created_at', { ascending: false })
  for (const row of ((data ?? []) as Array<{
    flow_run_id?: unknown
    person_name?: unknown
  }>)) {
    const id = typeof row.flow_run_id === 'string' ? row.flow_run_id : null
    const name = typeof row.person_name === 'string' ? row.person_name : null
    // DESC order → first occurrence per run wins (latest pick).
    if (id && name && !out.has(id)) out.set(id, name)
  }
  return out
}

/**
 * Validate that a caller-supplied flow_run_id belongs to the same
 * account + contact before accepting it. Returns the id when valid,
 * null otherwise (independent automation — sheets enrichment skipped,
 * message/tag behavior continues normally).
 */
export async function resolveFlowRunId(
  db: DbLike,
  accountId: string,
  contactId: string | null,
  flowRunId: string | null | undefined,
): Promise<string | null> {
  if (!flowRunId || !contactId) return null
  const { data } = await db
    .from('flow_runs')
    .select('id, account_id, contact_id')
    .eq('id', flowRunId)
    .maybeSingle()
  const row = data as { id?: string; account_id?: string; contact_id?: string | null } | null
  if (!row?.id) return null
  if (row.account_id !== accountId) return null
  if (row.contact_id !== contactId) return null
  return row.id
}
