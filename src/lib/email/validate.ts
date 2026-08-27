/**
 * Email validation shared by the flow validator, the node-config form,
 * and the send-time recipient resolver.
 *
 * Same basic shape used elsewhere in the app (see
 * src/components/settings/profile-form.tsx) — deliberately conservative:
 * enough to reject typos and header-injection garbage without blocking
 * legitimate addresses.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (v.length > 254) return false;
  return EMAIL_RE.test(v);
}

/**
 * Strip CR / LF / NUL so a user-authored subject or address can never
 * smuggle extra RFC-5322 header lines into the outbound message.
 * Nodemailer would encode these defensively, but this keeps the
 * invariant explicit at the point where untrusted text enters.
 */
export function sanitizeHeaderLine(value: string): string {
  return value.replace(/[\r\n\x00]/g, " ").trim();
}