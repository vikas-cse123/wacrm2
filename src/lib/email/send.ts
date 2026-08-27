/**
 * SMTP email delivery for flow email notifications.
 *
 * Server-side only: all credentials come from environment variables and
 * are NEVER stored in flow JSON or node configs. If SMTP isn't
 * configured the send throws ("SMTP not configured") — the caller (the
 * cron) records the job as failed/retryable and the WhatsApp flow is
 * never affected.
 *
 * Every network step (connect, greeting, socket) is bounded by
 * `EMAIL_TIMEOUT_MS` (default 10s) so a hanging provider can never
 * stall the cron or, transitively, the flow it belongs to.
 */

import nodemailer from "nodemailer";

import { sanitizeHeaderLine } from "./validate";

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || "";
// Fallback for bare SMTP relays that only need a sender envelope.
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "no-reply@localhost";
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS || "10000");

/** True when SMTP_HOST is present so emails can actually be sent. */
export function isEmailConfigured(): boolean {
  return Boolean(SMTP_HOST);
}

export interface EmailSendInput {
  to: string;
  subject: string;
  text: string;
}

/**
 * Build the nodemailer options for a notification. The subject is
 * scrubbed of CR/LF/NUL so user-authored text can't inject extra
 * headers; the body is passed as plain text so newlines are safe.
 */
export function buildMailOptions({ to, subject, text }: EmailSendInput) {
  return {
    from: SMTP_FROM,
    to,
    subject: sanitizeHeaderLine(subject),
    text,
  };
}

/** Fresh transporter per send — bounded, no shared-state surprises. */
export function createTransporter() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: SMTP_USER
      ? { user: SMTP_USER, pass: SMTP_PASSWORD }
      : undefined,
    connectionTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
  });
}

/**
 * Send one notification email. Throws on any failure (including
 * timeout and "SMTP not configured") so the caller can apply retry
 * policy. Never called from the flow engine's synchronous path.
 */
export async function sendEmailViaSmtp(input: EmailSendInput): Promise<void> {
  if (!isEmailConfigured()) {
    throw new Error("SMTP not configured");
  }
  const transporter = createTransporter();
  try {
    await transporter.sendMail(buildMailOptions(input));
  } finally {
    transporter.close();
  }
}