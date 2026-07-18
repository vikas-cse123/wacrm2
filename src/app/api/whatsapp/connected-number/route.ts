import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyPhoneNumber } from '@/lib/whatsapp/meta-api';

/**
 * Owner-only view of the real WhatsApp display number. Connection health is
 * available elsewhere, but the number itself is deliberately kept behind
 * this stricter endpoint so admins, agents, and viewers cannot retrieve it.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('owner');
    const { data: config, error } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[connected-number] config lookup failed:', error);
      return NextResponse.json(
        { connected: false, message: 'Could not load the WhatsApp connection.' },
        { status: 500 },
      );
    }

    if (!config) {
      return NextResponse.json({
        connected: false,
        message: 'No WhatsApp number is connected.',
      });
    }

    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
      });
      return NextResponse.json({
        connected: true,
        phone_number: phoneInfo.display_phone_number,
        verified_name: phoneInfo.verified_name ?? null,
      });
    } catch (error) {
      console.error(
        '[connected-number] Meta verification failed:',
        error instanceof Error ? error.message : error,
      );
      return NextResponse.json({
        connected: false,
        message: 'The saved WhatsApp connection could not be verified.',
      });
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
