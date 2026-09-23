import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for the follow-up scheduler.
// Mirrors src/lib/automations/admin-client.ts — the cron worker has
// no user JWT, so claiming + sending run through the service role
// with explicit account_id scoping on every query.
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
