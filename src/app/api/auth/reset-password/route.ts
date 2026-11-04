/**
 * POST /api/auth/reset-password
 *
 * Final step of "Forgot password?". The reset page has already called
 * supabase.auth.updateUser({ password }) inside the recovery session; this
 * stores the same new password for the app's own email/password login (the
 * `User` table's bcrypt hash), which is what /api/auth/login checks.
 *
 * Authorized by the recovery session itself: the Supabase access token must be
 * sent as a Bearer token, and Supabase must confirm it. That proves the caller
 * opened the reset link sent to this email — no other way to call this exists.
 *
 * Request: Authorization: Bearer <supabase access token>, JSON { password }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { setUserPassword } from "@/lib/supabaseAuthServer";

// Same rule as signup (src/app/api/auth/signup/route.ts).
const Schema = z.object({ password: z.string().min(8).max(200) });

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Your reset link has expired. Please request a new one." }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 422 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return NextResponse.json({ error: "Password reset is temporarily unavailable." }, { status: 500 });

  try {
    // Supabase validates the token server-side (signature, expiry, revocation).
    const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase.auth.getUser(token);
    const email = data?.user?.email;
    if (error || !email) {
      return NextResponse.json({ error: "Your reset link has expired. Please request a new one." }, { status: 401 });
    }

    const updated = await setUserPassword(email, parsed.data.password);
    if (!updated) {
      return NextResponse.json({ error: "No ShelfWatch account uses this email." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[reset-password] Unhandled error:", err);
    return NextResponse.json({ error: "Password reset is temporarily unavailable." }, { status: 500 });
  }
}
