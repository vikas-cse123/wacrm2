// ============================================================
// GET /api/auth/mobile-config — public Supabase connection
// details for first-party mobile apps (CallVault).
//
// Returns ONLY the publishable values — the project URL and the
// anon key, byte-identical to the NEXT_PUBLIC_* variables already
// shipped to every browser. The service-role key is never here,
// never in any client-reachable response.
//
// A mobile app needs these to talk to GoTrue directly
// (email/password sign-in, token refresh) without routing
// credentials through our servers.
// ============================================================

import { NextResponse } from 'next/server';

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json(
      { error: 'Mobile authentication is not configured' },
      { status: 503 }
    );
  }
  return NextResponse.json({ supabaseUrl, supabaseAnonKey });
}
