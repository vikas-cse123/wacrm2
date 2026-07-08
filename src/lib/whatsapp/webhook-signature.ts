import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * Each client's WhatsApp App has its own App Secret, so the caller
 * resolves the correct secret for the account this payload belongs
 * to (with an env fallback for legacy rows) and passes it in here.
 * This function no longer reads env vars itself.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | null | undefined,
): boolean {
  if (!secret) {
    console.error(
      '[webhook] No app secret resolved for this request — rejecting. ' +
        'Configure a per-account Meta App Secret in Settings, or set ' +
        'META_APP_SECRET as a fallback for legacy single-tenant rows.',
    )
    return false
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}