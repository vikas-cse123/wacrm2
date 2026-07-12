import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for Web Push fan-out. The push
// sender must read every account member's subscription row, which RLS
// would otherwise hide, so it runs with the service-role key.
// Mirrors src/lib/automations/admin-client.ts.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
