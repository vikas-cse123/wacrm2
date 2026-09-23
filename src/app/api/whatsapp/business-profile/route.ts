import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  getBusinessProfile,
  updateBusinessProfile,
  verifyPhoneNumber,
  BUSINESS_PROFILE_LIMITS,
  BUSINESS_VERTICALS,
  type BusinessProfileUpdate,
} from '@/lib/whatsapp/meta-api';
import { isValidHttpUrl } from '@/lib/whatsapp/business-profile';

/**
 * Admin-only Business Profile management (Settings → Workspace →
 * Business Profile). Meta is the source of truth — nothing is
 * stored locally. The access token is decrypted server-side and
 * never leaves this route.
 *
 *   GET   — current profile + verified name + display number.
 *   PATCH — update changed text fields (photo goes through
 *           POST /business-profile/photo).
 */

async function loadContext() {
  const { supabase, accountId } = await requireRole('admin');
  const { data: config, error } = await supabase
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !config) return { config: null as null | typeof config };
  return { config };
}

function metaErrorResponse(error: unknown): NextResponse {
  const message =
    error instanceof Error ? error.message : 'Meta API request failed.';
  console.error('[business-profile] Meta error:', message);
  return NextResponse.json({ error: message }, { status: 502 });
}

export async function GET() {
  try {
    const { config } = await loadContext();
    if (!config) {
      return NextResponse.json(
        { connected: false, message: 'No WhatsApp number is connected.' },
        { status: 400 },
      );
    }
    const accessToken = decrypt(config.access_token);
    try {
      const [profile, phone] = await Promise.all([
        getBusinessProfile({
          phoneNumberId: config.phone_number_id,
          accessToken,
        }),
        verifyPhoneNumber({
          phoneNumberId: config.phone_number_id,
          accessToken,
        }),
      ]);
      return NextResponse.json({
        connected: true,
        profile,
        phone_number: phone.display_phone_number,
        verified_name: phone.verified_name ?? null,
      });
    } catch (error) {
      return metaErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}

const TEXT_KEYS = ['about', 'address', 'description', 'email'] as const;
const MAX_LEN: Record<(typeof TEXT_KEYS)[number], number> = {
  about: BUSINESS_PROFILE_LIMITS.about,
  address: BUSINESS_PROFILE_LIMITS.address,
  description: BUSINESS_PROFILE_LIMITS.description,
  email: BUSINESS_PROFILE_LIMITS.email,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function PATCH(request: Request) {
  try {
    const { config } = await loadContext();
    if (!config) {
      return NextResponse.json(
        { connected: false, message: 'No WhatsApp number is connected.' },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    // Server-side mirror of the client validation (never trust input,
    // even from our own UI). Unknown keys are ignored, not forwarded.
    const fields: BusinessProfileUpdate = {};
    for (const key of TEXT_KEYS) {
      if (!(key in body)) continue;
      const value = body[key];
      if (value !== null && typeof value !== 'string') {
        return NextResponse.json(
          { error: `Field "${key}" must be a string or null.` },
          { status: 400 },
        );
      }
      const trimmed = (value ?? '').trim();
      if (trimmed.length > MAX_LEN[key]) {
        return NextResponse.json(
          { error: `Field "${key}" is too long.` },
          { status: 400 },
        );
      }
      if (key === 'email' && trimmed && !EMAIL_RE.test(trimmed)) {
        return NextResponse.json(
          { error: 'Enter a valid email address.' },
          { status: 400 },
        );
      }
      fields[key] = trimmed || null;
    }

    if ('vertical' in body) {
      const vertical = body.vertical;
      if (vertical !== null && typeof vertical !== 'string') {
        return NextResponse.json(
          { error: 'Field "vertical" must be a string or null.' },
          { status: 400 },
        );
      }
      const code = (vertical ?? '').trim().toUpperCase() || null;
      if (
        code &&
        !BUSINESS_VERTICALS.some((v) => v.code === code)
      ) {
        return NextResponse.json(
          { error: 'Select a valid category.' },
          { status: 400 },
        );
      }
      fields.vertical = code;
    }

    if ('websites' in body) {
      const websites = body.websites;
      if (
        !Array.isArray(websites) ||
        websites.length > BUSINESS_PROFILE_LIMITS.websitesMax ||
        websites.some((w) => typeof w !== 'string' || !isValidHttpUrl(w) || !w.trim())
      ) {
        return NextResponse.json(
          { error: 'Provide up to 2 valid http(s) website URLs.' },
          { status: 400 },
        );
      }
      fields.websites = websites.map((w) => (w as string).trim());
    }

    if (Object.keys(fields).length === 0) {
      return NextResponse.json(
        { error: 'No updatable fields provided.' },
        { status: 400 },
      );
    }

    const accessToken = decrypt(config.access_token);
    try {
      await updateBusinessProfile({
        phoneNumberId: config.phone_number_id,
        accessToken,
        fields,
      });
      // Re-read so the UI reflects exactly what Meta stored.
      const profile = await getBusinessProfile({
        phoneNumberId: config.phone_number_id,
        accessToken,
      });
      return NextResponse.json({ profile });
    } catch (error) {
      return metaErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
