/**
 * Types for the "Notify by email" flow node + its background jobs.
 *
 * The flow node (`EmailNotificationNodeConfig`) is part of the flows
 * discriminated union (see src/lib/flows/types.ts) and is authored in
 * the flow builder like any other node. The `FlowEmailNotificationRow`
 * is the durable outbox row the runner enqueues and the cron drains —
 * the network call to the email provider never happens on the flow's
 * synchronous execution path.
 */

/** Where the notification email goes. */
export type EmailRecipientMode = "my_email" | "custom";

/**
 * Config stored on an `email_notification` flow node. All fields are
 * authored in the builder UI; no SMTP/provider credentials ever live
 * here — those come from server-side env vars at send time.
 */
export interface EmailNotificationNodeConfig {
  /**
   * "my_email" (default) — resolved at send time to the account
   * owner's email. "custom" — `recipient_email` is used instead.
   */
  recipient_mode: EmailRecipientMode;
  /** Only used when `recipient_mode === 'custom'`. */
  recipient_email?: string;
  /** Notification subject; supports {{vars.*}} / {{contact.*}} / {{flow.name}}. */
  subject: string;
  /** Notification body; supports {{vars.*}} / {{contact.*}} / {{flow.name}}. */
  body: string;
  /** Auto-advance target — the email is background, never blocking. */
  next_node_key: string;
}

export type FlowEmailStatus = "queued" | "sending" | "sent" | "failed";

/** DB row shape for `flow_email_notifications`. */
export interface FlowEmailNotificationRow {
  id: string;
  account_id: string;
  user_id: string;
  flow_id: string;
  flow_run_id: string;
  contact_id: string | null;
  node_key: string | null;
  recipient_mode: EmailRecipientMode;
  recipient: string | null;
  subject: string;
  body: string;
  vars: Record<string, unknown>;
  status: FlowEmailStatus;
  attempt: number;
  max_attempts: number;
  last_error: string | null;
  queued_at: string;
  next_attempt_at: string;
  sent_at: string | null;
  /** Provider message id when the email was accepted (Resend id / SMTP Message-Id). */
  sent_message_id: string | null;
  failed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Result returned to the flow engine when a node enqueues an email. */
export interface EnqueueEmailResult {
  ok: boolean;
  /** Job id when the row was inserted; else null. */
  jobId?: string;
  /** Reason when `ok` is false — logged by the engine, never fatal. */
  error?: string;
}

/** Aggregate reported by one cron sweep. */
export interface EmailDrainResult {
  /** Jobs actually sent this sweep. */
  sent: number;
  /** Jobs that failed this sweep (will retry later). */
  failed: number;
  /** Jobs that exhausted all attempts — terminal failure, logged. */
  finalFailures: number;
}