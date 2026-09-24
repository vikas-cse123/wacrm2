// ============================================================
// WhatsApp Reminder model + validation (server and client share
// these so the dialog and the API reject identically).
//
// User-facing name is "Reminders". Internal identifiers
// (`whatsapp_followups`, `/api/followups`) are unchanged.
//
// Product model: a reminder is delivered TO ITS CREATOR's stored
// WhatsApp number (`recipient_phone`, snapshotted at creation).
// The customer (`contact_id`) is optional context only and NEVER
// determines the destination.
//
// Timezone: scheduled_for is an absolute UTC instant. The dialog
// collects local date + time in the AGENT'S browser timezone (the
// same convention as dashboard analytics' tz handling) and sends
// ISO; display re-localizes in the browser. Never hardcode a zone.
// ============================================================

import {
  isValidE164,
  sanitizePhoneForMeta,
} from "@/lib/whatsapp/phone-utils";

export const FOLLOWUP_STATUSES = [
  'scheduled',
  'processing',
  'sent',
  'failed',
  'cancelled',
] as const;

export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

export function isFollowupStatus(value: unknown): value is FollowupStatus {
  return (
    typeof value === 'string' &&
    (FOLLOWUP_STATUSES as readonly string[]).includes(value)
  );
}

export interface Followup {
  id: string;
  account_id: string;
  /**
   * Immutable recipient snapshot: the creating agent's own WhatsApp
   * number (digits-only E.164) captured at creation. The scheduler
   * sends ONLY here. NULL only on legacy pre-snapshot rows, which
   * the scheduler fails loudly instead of guessing.
   */
  recipient_phone: string | null;
  /** Optional customer context only — NEVER the recipient. */
  contact_id: string | null;
  conversation_id: string | null;
  scheduled_for: string;
  message_text: string;
  template_name: string | null;
  template_language: string | null;
  status: FollowupStatus;
  attempts: number;
  whatsapp_message_id: string | null;
  message_id: string | null;
  sent_at: string | null;
  cancelled_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** List-view enrichment only (never persisted on the row). */
  contact_name?: string | null;
  contact_phone?: string | null;
}

/** Meta text-message body cap — mirrors WhatsApp's 4096 limit. */
export const FOLLOWUP_MESSAGE_MAX = 4096;

export interface FollowupInput {
  contact_id: unknown;
  scheduled_for: unknown;
  message_text: unknown;
  template_name?: unknown;
  template_language?: unknown;
}

export interface ValidFollowupInput {
  contact_id: string | null;
  scheduled_for: string;
  message_text: string;
  template_name: string | null;
  template_language: string | null;
}

/**
 * Normalize a candidate agent WhatsApp number into the canonical
 * digits-only E.164 form Meta expects (`sanitizePhoneForMeta`),
 * or return null when it is missing/invalid. Shared by the
 * profile form (client), the reminder dialog (client), and
 * POST /api/followups (server) so all three agree.
 *
 * Never falls back to anything: no email, no business number, no
 * customer phone. Null means "fail closed".
 */
export function normalizeRecipientPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sanitized = sanitizePhoneForMeta(value);
  if (!sanitized || !isValidE164(sanitized)) return null;
  return sanitized;
}

/**
 * Validate create/edit input. contact_id is OPTIONAL (null/empty =
 * personal reminder with no customer context). scheduled_for must
 * be a future ISO instant (past times are rejected, never silently
 * shifted). Throws with a human-readable message.
 */
export function validateFollowupInput(
  input: FollowupInput,
  now: Date = new Date(),
): ValidFollowupInput {
  let contact_id: string | null = null;
  if (
    input.contact_id !== undefined &&
    input.contact_id !== null &&
    input.contact_id !== ""
  ) {
    if (typeof input.contact_id !== "string" || !input.contact_id) {
      throw new Error("Customer selection is invalid.");
    }
    contact_id = input.contact_id;
  }
  if (typeof input.scheduled_for !== 'string' || !input.scheduled_for) {
    throw new Error('Choose a date and time.');
  }
  const at = new Date(input.scheduled_for);
  if (Number.isNaN(at.getTime())) {
    throw new Error('Scheduled time is not a valid date.');
  }
  if (at.getTime() <= now.getTime()) {
    throw new Error('Scheduled time must be in the future.');
  }
  if (typeof input.message_text !== 'string' || !input.message_text.trim()) {
    throw new Error('Write a message for this reminder.');
  }
  const message_text = input.message_text.trim();
  if (message_text.length > FOLLOWUP_MESSAGE_MAX) {
    throw new Error(
      `Message must be ${FOLLOWUP_MESSAGE_MAX} characters or fewer.`,
    );
  }
  let template_name: string | null = null;
  let template_language: string | null = null;
  if (
    input.template_name !== undefined &&
    input.template_name !== null &&
    input.template_name !== ''
  ) {
    if (typeof input.template_name !== 'string' || !input.template_name.trim()) {
      throw new Error('Template name is invalid.');
    }
    template_name = input.template_name.trim();
    template_language =
      typeof input.template_language === 'string' && input.template_language.trim()
        ? input.template_language.trim()
        : 'en_US';
  }
  return {
    contact_id,
    scheduled_for: at.toISOString(),
    message_text,
    template_name,
    template_language,
  };
}
