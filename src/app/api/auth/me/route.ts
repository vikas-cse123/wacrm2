// ============================================================
// GET /api/auth/me — who am I, for a logged-in device.
//
// Authenticates a Supabase user access token (same mechanism as
// device uploads) and returns the identity CallVault shows in
// its "connected" state: the user, their account, their role,
// and their effective WhatsApp recording source (the mutually
// exclusive allowlist CallVault enforces — absent row means
// 'none'). Account, role, and source come from server-side
// lookups — never from client input.
// ============================================================

import { NextResponse } from 'next/server';

import { requireDeviceUser } from '@/lib/auth/device';
import { toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(request: Request) {
  try {
    const dev = await requireDeviceUser(request);
    const { data: account } = await dev.service
      .from('accounts')
      .select('id, name')
      .eq('id', dev.accountId)
      .maybeSingle();
    const { data: setting } = await dev.service
      .from('user_recording_settings')
      .select('whatsapp_recording_source')
      .eq('account_id', dev.accountId)
      .eq('user_id', dev.userId)
      .maybeSingle();
    const source = (setting as { whatsapp_recording_source?: unknown } | null)
      ?.whatsapp_recording_source;
    return NextResponse.json({
      user: { id: dev.userId, email: dev.email, fullName: dev.fullName },
      account: account ?? { id: dev.accountId, name: null },
      role: dev.role,
      whatsappRecordingSource:
        source === 'whatsapp' || source === 'whatsapp_business' ? source : 'none',
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
