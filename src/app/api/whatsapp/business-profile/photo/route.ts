import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  getBusinessProfile,
  updateBusinessProfile,
  uploadProfilePhoto,
} from '@/lib/whatsapp/meta-api';
import { validateProfilePhoto } from '@/lib/whatsapp/business-profile';

/**
 * POST /api/whatsapp/business-profile/photo — replace the WhatsApp
 * Business profile photo. Admin-only; multipart form with a `file`
 * field (JPEG/PNG, ≤5MB).
 *
 * Meta flow (Cloud API, resumable upload — there is NO
 * /{phone-number-id}/profile/photo edge):
 *   1. resumable session → upload bytes → image handle,
 *   2. set it via profile_picture_handle on whatsapp_business_profile,
 *   3. re-read the profile and return Meta's profile_picture_url.
 *
 * Both Meta steps happen here so the browser never sees the upload
 * handle or the access token. Bytes stay in memory only for the
 * request; nothing is stored in WACRM — Meta is the source of truth.
 * Upload and profile-update failures are reported separately
 * (`stage: 'upload' | 'update'`) so the UI never shows a success
 * when Meta rejected the photo.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { data: config, error } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token, meta_app_id')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error || !config) {
      return NextResponse.json(
        { connected: false, message: 'No WhatsApp number is connected.' },
        { status: 400 },
      );
    }

    // Resumable upload is app-scoped: prefer the account's own Meta
    // App ID (Settings → WhatsApp), fall back to the global env var
    // for single-tenant / local setups.
    const appId =
      (config.meta_app_id as string | null)?.trim() ||
      process.env.META_APP_ID?.trim();
    if (!appId) {
      return NextResponse.json(
        {
          error:
            'Photo upload needs a Meta App ID. Add it in Settings → WhatsApp (Meta App ID field).',
          stage: 'upload',
        },
        { status: 400 },
      );
    }

    let file: File | null = null;
    try {
      const form = await request.formData();
      const entry = form.get('file');
      if (entry instanceof File) file = entry;
    } catch {
      file = null;
    }
    if (!file) {
      return NextResponse.json(
        { error: 'Attach a photo file.' },
        { status: 400 },
      );
    }

    const problem = validateProfilePhoto({
      mimeType: file.type,
      sizeBytes: file.size,
    });
    if (problem) {
      return NextResponse.json({ error: problem }, { status: 400 });
    }

    const accessToken = decrypt(config.access_token);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let handle: string;
    try {
      ({ handle } = await uploadProfilePhoto({
        appId,
        accessToken,
        fileName: file.name || 'profile-photo',
        mimeType: file.type,
        bytes,
      }));
    } catch (metaError) {
      const message =
        metaError instanceof Error ? metaError.message : 'Meta API request failed.';
      console.error('[business-profile/photo] upload failed:', message);
      return NextResponse.json(
        { error: `Photo upload failed: ${message}`, stage: 'upload' },
        { status: 502 },
      );
    }
    try {
      await updateBusinessProfile({
        phoneNumberId: config.phone_number_id,
        accessToken,
        fields: { profile_picture_handle: handle },
      });
      const profile = await getBusinessProfile({
        phoneNumberId: config.phone_number_id,
        accessToken,
      });
      return NextResponse.json({ profile });
    } catch (metaError) {
      const message =
        metaError instanceof Error ? metaError.message : 'Meta API request failed.';
      console.error('[business-profile/photo] profile update failed:', message);
      // The bytes reached Meta but the picture was not applied — say
      // so explicitly instead of reporting a success.
      return NextResponse.json(
        { error: `Profile update failed: ${message}`, stage: 'update' },
        { status: 502 },
      );
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
