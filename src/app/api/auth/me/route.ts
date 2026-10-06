// ============================================================
// GET /api/auth/me — who am I, for a logged-in device.
//
// Authenticates a Supabase user access token (same mechanism as
// device uploads) and returns the identity CallVault shows in
// its "connected" state: the user, their account, and their role.
// Account and role come from the server-side profile lookup —
// never from client input.
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
    return NextResponse.json({
      user: { id: dev.userId, email: dev.email, fullName: dev.fullName },
      account: account ?? { id: dev.accountId, name: null },
      role: dev.role,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
