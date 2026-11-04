/**
 * GET /auth/callback?flow=google|recovery[&redirect=/path]
 *
 * Where Supabase Auth sends the browser back to, for both:
 *
 *  - flow=google   — after "Continue with Google". Exchanges the PKCE code for
 *                    a Supabase session, finds or creates the matching `User`
 *                    row (one per email — an existing email/password account
 *                    is reused, not duplicated), then sets the app's own
 *                    `customer_session` cookie exactly as the email/password
 *                    login does, so proxy.ts, /api/auth/me, logout and scans
 *                    all work unchanged. The Supabase session is then cleared:
 *                    the app never reads it.
 *  - flow=recovery — from the "reset password" email. Establishes the
 *                    recovery session (PKCE `code`, or `token_hash` when the
 *                    email template links that way) and sends the user to
 *                    /reset-password to choose a new password.
 *
 * Failures (cancelled Google consent, expired or reused links) redirect with
 * an `error` code the login / reset pages explain.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  createRouteSupabase,
  findOrCreateUserForEmail,
  safeRedirectPath,
  setCustomerSessionCookie,
} from "@/lib/supabaseAuthServer";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const flow = params.get("flow") === "recovery" ? "recovery" : "google";
  const to = (path: string, error?: string) => {
    const url = new URL(path, req.nextUrl.origin);
    if (error) url.searchParams.set("error", error);
    return url;
  };

  // The provider or Supabase reported a failure before we got a code —
  // most often the user closed or declined the Google consent screen.
  const providerError = params.get("error");
  if (providerError) {
    console.warn(`[auth/callback] ${flow} error: ${providerError} — ${params.get("error_description") ?? ""}`);
    return NextResponse.redirect(
      flow === "recovery"
        ? to("/reset-password", "link_invalid")
        : to("/login", providerError === "access_denied" ? "google_cancelled" : "google_failed")
    );
  }

  let route: ReturnType<typeof createRouteSupabase>;
  try {
    route = createRouteSupabase(req);
  } catch (err) {
    console.error("[auth/callback] Supabase not configured:", err);
    return NextResponse.redirect(to(flow === "recovery" ? "/reset-password" : "/login", "auth_unavailable"));
  }
  const { supabase, applyCookies } = route;

  // ── Password recovery ─────────────────────────────────────────────────────
  if (flow === "recovery") {
    const code = params.get("code");
    const tokenHash = params.get("token_hash");
    const { error } = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : tokenHash
        ? await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash })
        : { error: new Error("Missing code") };
    if (error) {
      console.warn("[auth/callback] recovery link rejected:", error.message);
      return applyCookies(NextResponse.redirect(to("/reset-password", "link_expired")));
    }
    return applyCookies(NextResponse.redirect(to("/reset-password")));
  }

  // ── Google sign-in ────────────────────────────────────────────────────────
  const code = params.get("code");
  if (!code) return NextResponse.redirect(to("/login", "google_failed"));

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  const email = data?.user?.email;
  if (error || !email) {
    console.warn("[auth/callback] Google code exchange failed:", error?.message ?? "no email on the account");
    return applyCookies(NextResponse.redirect(to("/login", "google_failed")));
  }

  try {
    const meta = data.user.user_metadata ?? {};
    const displayName = (meta.full_name ?? meta.name ?? null) as string | null;
    const user = await findOrCreateUserForEmail(email, displayName);

    // The app's session is customer_session; don't leave a second, unused
    // login lying around in Supabase cookies.
    await supabase.auth.signOut({ scope: "local" });

    const res = NextResponse.redirect(to(safeRedirectPath(params.get("redirect"))));
    await setCustomerSessionCookie(res, user);
    return applyCookies(res);
  } catch (err) {
    console.error("[auth/callback] Linking the Google account failed:", err);
    return applyCookies(NextResponse.redirect(to("/login", "google_failed")));
  }
}
