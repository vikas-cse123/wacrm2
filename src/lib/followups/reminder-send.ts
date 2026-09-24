import type { SupabaseClient } from "@supabase/supabase-js";

import { decrypt } from "@/lib/whatsapp/encryption";
import { sendTextMessage } from "@/lib/whatsapp/meta-api";
import { SendMessageError } from "@/lib/whatsapp/send-message";

// Re-exported so scheduler callers import the sender and its error
// type from one module.
export { SendMessageError };

// ============================================================
// Self-reminder send: deliver a reminder TO ITS CREATOR's stored
// WhatsApp number (`recipient_phone` snapshot on the reminder row)
// FROM the account's connected WhatsApp Business number.
//
// This is deliberately NOT `sendMessageToConversation`: a personal
// reminder must never open/touch a customer conversation, persist
// a customer `messages` row, pause flow runs, mutate conversation
// previews, auto-correct contact phones, or consult the 24-hour
// customer-service window. The ONLY database reads here are the
// account-scoped `whatsapp_config` (sender credentials); the ONLY
// write the caller performs is the reminder row's own status.
//
// `db` may be the service-role client (cron worker). Every query
// is filtered by `accountId`, so tenancy holds regardless.
// ============================================================

export interface ReminderSendParams {
  /**
   * Immutable snapshot from the reminder row — the creating
   * agent's own WhatsApp number (digits-only E.164). Never derived
   * here; the caller passes exactly what the row stores.
   */
  to: string;
  /** Reminder body (already trimmed, within Meta's text cap). */
  text: string;
}

export interface ReminderSendResult {
  /** Meta's `wamid` for the delivered message. */
  whatsappMessageId: string;
}

export async function sendReminderToAgent(
  db: SupabaseClient,
  accountId: string,
  params: ReminderSendParams,
): Promise<ReminderSendResult> {
  const { to, text } = params;

  if (!to) {
    throw new SendMessageError(
      "bad_request",
      "Reminder has no recipient phone number.",
      400,
    );
  }
  if (!text) {
    throw new SendMessageError("bad_request", "Reminder text is required.", 400);
  }

  // Sender: the account's connected WhatsApp Business number.
  const { data: config, error: configError } = await db
    .from("whatsapp_config")
    .select("phone_number_id, access_token")
    .eq("account_id", accountId)
    .maybeSingle();

  if (configError || !config) {
    throw new SendMessageError(
      "whatsapp_not_configured",
      "WhatsApp not configured. Please set up your WhatsApp integration first.",
      400,
    );
  }

  const row = config as {
    phone_number_id: string;
    access_token: string;
  };
  if (!row.phone_number_id || !row.access_token) {
    throw new SendMessageError(
      "whatsapp_not_configured",
      "WhatsApp not configured. Please set up your WhatsApp integration first.",
      400,
    );
  }

  let accessToken: string;
  try {
    accessToken = decrypt(row.access_token);
  } catch {
    throw new SendMessageError(
      "whatsapp_not_configured",
      "WhatsApp credentials could not be read. Please reconnect WhatsApp in Settings.",
      400,
    );
  }

  try {
    const result = await sendTextMessage({
      phoneNumberId: row.phone_number_id,
      accessToken,
      to,
      text,
    });
    return { whatsappMessageId: result.messageId };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown Meta API error";
    throw new SendMessageError("meta_error", `Meta API error: ${message}`, 502);
  }
}
