/**
 * POST /api/auth/forgot-password
 *
 * Step one of "Forgot password?". Customers live in the app's own `User` table,
 * not in Supabase Auth — and Supabase only sends a reset email to users it
 * knows. So, for an email that has a ShelfWatch account, this makes sure a
 * matching Supabase Auth user exists (email pre-confirmed: the account
 * already owns that address). The browser then calls
 * supabase.auth.resetPasswordForEmail() itself, so the PKCE verifier is kept
 * in that browser for /auth/callback.
 *
 * Always answers { ok: true } for a well-formed email, whether or not an
 * account exists — the response must not reveal who is registered.
 *
 * Request (application/json): { email }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseEnv } from "@/lib/supabaseEnv";
import { createAdminSupabase } from "@/lib/supabaseAuthServer";

const Schema = z.object({ email: z.string().trim().email().max(200) });

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 422 });
  }
  const email = parsed.data.email.toLowerCase();

  const { supabaseUrl, anonKey } = getSupabaseEnv();
  const admin = createAdminSupabase();
  if (!supabaseUrl || !anonKey || !admin) {
    return NextResponse.json({ error: "Password reset is temporarily unavailable." }, { status: 500 });
  }

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/User?email=eq.${encodeURIComponent(email)}&select=id`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    const rows = res.ok ? ((await res.json()) as unknown[]) : [];

    if (rows.length > 0) {
      const { error } = await admin.auth.admin.createUser({ email, email_confirm: true });
      // Already in Supabase Auth (an earlier reset, or a Google sign-in) is fine.
      if (error && error.code !== "email_exists" && !/already/i.test(error.message)) {
        console.error("[forgot-password] Could not prepare the auth user:", error.message);
        return NextResponse.json({ error: "Password reset is temporarily unavailable." }, { status: 500 });
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[forgot-password] Unhandled error:", err);
    return NextResponse.json({ error: "Password reset is temporarily unavailable." }, { status: 500 });
  }
}
