/**
 * src/lib/supabaseEnv.ts
 *
 * Helper to retrieve Supabase URL and API Key from environment variables,
 * supporting both public (NEXT_PUBLIC_*) and server-side (SUPABASE_*) env var names.
 */

export function getSupabaseEnv(): { supabaseUrl: string | undefined; anonKey: string | undefined } {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  return { supabaseUrl, anonKey };
}
