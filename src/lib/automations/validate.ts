import type { AutomationTriggerType } from '@/types'

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string
  message: string
}

interface StepLike {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: StepLike[]; no?: StepLike[] }
}

export function validateStepsForActivation(steps: StepLike[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'active automations need at least one step',
    })
    return issues
  }
  walk(steps, '', issues)
  // Single Assign column → at most one assign_person per automation
  let assignCount = 0
  const countAssign = (list: StepLike[]) => {
    for (const s of list) {
      if (s.step_type === 'assign_person') assignCount += 1
      if (s.step_type === 'condition' && s.branches) {
        if (s.branches.yes) countAssign(s.branches.yes)
        if (s.branches.no) countAssign(s.branches.no)
      }
    }
  }
  countAssign(steps)
  if (assignCount > 1) {
    issues.push({ path: 'steps', message: 'only one Assign Person step is allowed per automation (single Assign column)' })
  }
  return issues
}

function walk(steps: StepLike[], prefix: string, issues: ValidationIssue[]): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`
    validateOne(s, path, issues)
    if (s.step_type === 'condition' && s.branches) {
      if (s.branches.yes) walk(s.branches.yes, `${path}.yes.`, issues)
      if (s.branches.no) walk(s.branches.no, `${path}.no.`, issues)
    }
  })
}

function validateOne(step: StepLike, path: string, issues: ValidationIssue[]): void {
  const c = step.step_config ?? {}
  switch (step.step_type) {
    case 'send_message':
      if (!nonEmpty(c.text)) {
        issues.push({ path: `${path}.text`, message: 'message text is required' })
      }
      break
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({ path: `${path}.template_name`, message: 'template name is required' })
      }
      break
    case 'send_media': {
      // Rotation mode carries its own ordered message list; every entry
      // must pass the same media checks as a fixed message. Absent
      // selection_mode (all legacy configs) is fixed — no migration.
      // Only an explicit 'rotate' mode enters this branch: the builder
      // keeps a stale `messages` array on the config when a user toggles
      // back to Fixed, and the engine ignores that array in fixed mode
      // (see rotationMessages in engine.ts) — so validating it there
      // would block saves the engine considers valid.
      if (c.selection_mode === 'rotate') {
        const msgs = Array.isArray(c.messages) ? c.messages : []
        if (msgs.length < 2) {
          issues.push({
            path: `${path}.messages`,
            message: 'rotate messages needs at least 2 messages',
          })
        }
        msgs.forEach((m, i) => {
          if (!['image', 'video', 'document'].includes(String(m?.media_type))) {
            issues.push({
              path: `${path}.messages[${i}].media_type`,
              message: `message ${i + 1}: media type must be image, video, or document`,
            })
          }
          if (!nonEmpty(m?.media_url)) {
            issues.push({
              path: `${path}.messages[${i}].media_url`,
              message: `message ${i + 1}: media file is required`,
            })
          }
        })
        break
      }
      if (!['image', 'video', 'document'].includes(String(c.media_type))) {
        issues.push({
          path: `${path}.media_type`,
          message: 'media type must be image, video, or document',
        })
      }
      if (!nonEmpty(c.media_url)) {
        issues.push({ path: `${path}.media_url`, message: 'media file is required' })
      }
      break
    }
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: 'tag is required' })
      }
      break
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: 'agent is required when mode is "specific"',
        })
      }
      break
    case 'assign_person': {
      const persons = Array.isArray(c.persons) ? c.persons : []
      if (persons.length === 0) {
        issues.push({ path: `${path}.persons`, message: 'at least one person is required' })
        break
      }
      const seen = new Set<string>()
      let total = 0
      persons.forEach((p, i) => {
        const name = typeof p?.name === 'string' ? p.name.trim() : ''
        if (!name) {
          issues.push({ path: `${path}.persons[${i}].name`, message: `person ${i + 1}: name is required` })
        } else {
          const lower = name.toLowerCase()
          if (seen.has(lower)) {
            issues.push({ path: `${path}.persons[${i}].name`, message: `person ${i + 1}: names must be unique` })
          }
          seen.add(lower)
        }
        const pct = Number(p?.percentage)
        if (!Number.isFinite(pct) || pct <= 0) {
          issues.push({ path: `${path}.persons[${i}].percentage`, message: `person ${i + 1}: percentage must be greater than 0` })
        } else {
          total += pct
        }
        // Absent = text (configs saved before message types existed).
        const rawType = p?.message_type
        if (rawType !== undefined && rawType !== 'text' && rawType !== 'image') {
          issues.push({ path: `${path}.persons[${i}].message_type`, message: `person ${i + 1}: message type must be text or image` })
        }
        const messageType = rawType === 'image' ? 'image' : 'text'
        if (!nonEmpty(p?.message)) {
          issues.push({ path: `${path}.persons[${i}].message`, message: `person ${i + 1}: message is required` })
        }
        if (messageType === 'image' && !nonEmpty(p?.media_url)) {
          issues.push({ path: `${path}.persons[${i}].media_url`, message: `person ${i + 1}: image is required` })
        }
        if (!nonEmpty(p?.tag_id)) {
          issues.push({ path: `${path}.persons[${i}].tag_id`, message: `person ${i + 1}: tag is required` })
        }
      })
      // Total must equal 100 (small epsilon for float input from UI).
      if (persons.length > 0 && Math.abs(total - 100) > 0.001) {
        issues.push({ path: `${path}.persons`, message: `percentages must total 100 (currently ${total})` })
      }
      break
    }
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({ path: `${path}.field`, message: 'field name is required' })
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({ path: `${path}.value`, message: 'field value is required' })
      }
      break
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({ path: `${path}.pipeline_id`, message: 'pipeline is required' })
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: 'stage is required' })
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: 'title is required' })
      }
      break
    case 'wait':
      if (typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount <= 0) {
        issues.push({ path: `${path}.amount`, message: 'wait amount must be greater than 0' })
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: 'wait unit must be minutes, hours, or days',
        })
      }
      break
    case 'condition':
      if (!nonEmpty(c.subject)) {
        issues.push({ path: `${path}.subject`, message: 'condition subject is required' })
      }
      if (!nonEmpty(c.operand)) {
        issues.push({ path: `${path}.operand`, message: 'condition operand is required' })
      }
      break
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({ path: `${path}.url`, message: 'webhook URL is required' })
        break
      }
      try {
        const u = new URL(String(c.url))
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: 'webhook URL must use http or https',
          })
        }
      } catch {
        issues.push({ path: `${path}.url`, message: 'webhook URL is not a valid URL' })
      }
      break
    case 'close_conversation':
      // No config required.
      break
    default:
      issues.push({ path, message: `unknown step type: ${step.step_type}` })
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({ path: 'trigger.keywords', message: 'at least one keyword is required' })
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({ path: 'trigger.keywords', message: 'keywords cannot be empty strings' })
    }
    // A missing match_type defaults to "contains" at runtime (see
    // automations/engine.ts and flows/engine.ts, which both read
    // `match_type ?? "contains"`), so only an explicit, unrecognised
    // value is invalid here. This keeps activation validation in step
    // with the engine and with the builder's "Contains" default — an
    // automation that shows the default in the UI must not be rejected.
    if (cfg.match_type != null && cfg.match_type !== 'exact' && cfg.match_type !== 'contains') {
      issues.push({
        path: 'trigger.match_type',
        message: 'match type must be "exact" or "contains"',
      })
    }
  } else if (triggerType === 'time_based') {
    if (!nonEmpty(cfg.schedule)) {
      issues.push({ path: 'trigger.schedule', message: 'schedule is required' })
    }
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: 'tag is required' })
    }
  }

  return issues
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Cross-check: warn when an assign_person's tag IS the automation's own
 * tag_added trigger (the engine skips that dispatch at runtime to avoid
 * a self-loop, so activating it is almost certainly a misconfiguration).
 * Returns issues (activation-blocking) — drafts can still save.
 */
export function validateAssignmentTrigger(
  steps: StepLike[],
  triggerType: string,
  triggerConfig: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (triggerType !== 'tag_added') return issues
  const triggerTag = (triggerConfig as Record<string, unknown> | null)?.tag_id
  if (typeof triggerTag !== 'string' || !triggerTag.trim()) return issues
  const walkSteps = (list: StepLike[], prefix: string): void => {
    list.forEach((s, i) => {
      const path = `${prefix}steps[${i}]`
      if (s.step_type === 'assign_person' && s.step_config) {
        const persons = Array.isArray((s.step_config as Record<string, unknown>).persons)
          ? ((s.step_config as Record<string, unknown>).persons as Array<Record<string, unknown>>)
          : []
        persons.forEach((p, j) => {
          if (typeof p?.tag_id === 'string' && p.tag_id === triggerTag) {
            issues.push({
              path: `${path}.persons[${j}].tag_id`,
              message: 'this tag is the automation’s own trigger — pick a different tag to avoid a loop',
            })
          }
        })
      }
      if (s.step_type === 'condition' && s.branches) {
        if (s.branches.yes) walkSteps(s.branches.yes, `${path}.yes.`)
        if (s.branches.no) walkSteps(s.branches.no, `${path}.no.`)
      }
    })
  }
  walkSteps(steps, '')
  return issues
}
