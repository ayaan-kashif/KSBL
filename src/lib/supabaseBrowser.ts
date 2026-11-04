'use client';

/**
 * src/lib/supabaseBrowser.ts
 *
 * The one browser-side Supabase client, used ONLY for Supabase Auth flows:
 * "Continue with Google" (OAuth) and password recovery. Everything else in the
 * app still talks to Supabase over REST, and the customer's logged-in state is
 * still the app's own `customer_session` cookie (src/lib/auth.ts) — Supabase
 * Auth just proves who the person is, then hands over to that.
 *
 * @supabase/ssr keeps the PKCE verifier and session in cookies (not
 * localStorage), so the server route /auth/callback can finish the exchange.
 * Uses the public URL + anon key that are already in the environment.
 */

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabaseBrowser(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      throw new Error('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY).');
    }
    client = createBrowserClient(url, anonKey);
  }
  return client;
}

/**
 * Where Supabase sends the browser back to after Google or a reset link.
 * Built from the current origin, so the same code works on localhost, Vercel
 * previews and production — each origin must be allow-listed in Supabase
 * (Authentication → URL Configuration → Redirect URLs).
 */
export function authCallbackUrl(flow: 'google' | 'recovery', redirect?: string): string {
  const url = new URL('/auth/callback', window.location.origin);
  url.searchParams.set('flow', flow);
  if (redirect) url.searchParams.set('redirect', redirect);
  return url.toString();
}
