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
 * Both Meta steps happen here so the browser never sees the upload
 * handle: upload → handle → set as profile picture → re-read the
 * profile and return it. Bytes stay in memory only for the request.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { data: config, error } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error || !config) {
      return NextResponse.json(
        { connected: false, message: 'No WhatsApp number is connected.' },
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
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { handle } = await uploadProfilePhoto({
        phoneNumberId: config.phone_number_id,
        accessToken,
        fileName: file.name || 'profile-photo',
        mimeType: file.type,
        bytes,
      });
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
      console.error('[business-profile/photo] Meta error:', message);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
