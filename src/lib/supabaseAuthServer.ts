/**
 * src/lib/supabaseAuthServer.ts
 *
 * Server-side Supabase Auth helpers for the Google sign-in and password-reset
 * routes. Customer sessions are still the app's own `customer_session` cookie
 * (src/lib/auth.ts); these helpers only finish Supabase's half of a flow and
 * link the result to the existing `User` table.
 *
 * Secrets stay server-side: the Google client secret lives only in the
 * Supabase dashboard (Authentication → Providers → Google), and the service
 * role key is read from the environment, never sent to the browser.
 */

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest, NextResponse } from "next/server";
import { CUSTOMER_SESSION_COOKIE, signCustomerSession } from "./auth";
import { getSupabaseEnv } from "./supabaseEnv";

/**
 * A Supabase client bound to one route request: it reads the PKCE verifier /
 * session cookies from the request, and collects the cookies Supabase wants
 * to set so they can be applied to whichever response the route returns.
 */
export function createRouteSupabase(req: NextRequest): {
  supabase: SupabaseClient;
  applyCookies: (res: NextResponse) => NextResponse;
} {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Supabase is not configured");

  const pending: { name: string; value: string; options: Parameters<NextResponse["cookies"]["set"]>[2] }[] = [];
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => req.cookies.getAll().map(({ name, value }) => ({ name, value })),
      setAll: (cookies) => {
        for (const c of cookies) pending.push({ name: c.name, value: c.value, options: c.options });
      },
    },
  });
  return {
    supabase,
    applyCookies: (res) => {
      for (const c of pending) res.cookies.set(c.name, c.value, c.options);
      return res;
    },
  };
}

/** Supabase client with the service-role key, for the admin API. Server only. */
export function createAdminSupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Same cookie the email/password login sets (src/app/api/auth/login/route.ts). */
export async function setCustomerSessionCookie(
  res: NextResponse,
  user: { id: string; email: string; name: string }
): Promise<NextResponse> {
  const token = await signCustomerSession({ sub: user.id, email: user.email, name: user.name });
  res.cookies.set(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
}

async function findUserByEmail(email: string): Promise<UserRow | null> {
  const { supabaseUrl, anonKey } = getSupabaseEnv();
  if (!supabaseUrl || !anonKey) throw new Error("Server configuration is missing");
  const res = await fetch(`${supabaseUrl}/rest/v1/User?email=eq.${encodeURIComponent(email)}&select=id,name,email`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  });
  if (!res.ok) throw new Error(`User lookup failed (${res.status})`);
  return ((await res.json()) as UserRow[])[0] ?? null;
}

/**
 * The `User` row for a Google-verified email: the existing one if this email
 * already has an account (email/password or an earlier Google sign-in), else
 * a new one. Exactly one row per email — `User.email` is unique, and a
 * concurrent first sign-in that loses the insert race re-reads the winner.
 *
 * A new Google-only account gets an unusable random password hash (the column
 * is required); "Forgot password?" can later give it a real password.
 */
export async function findOrCreateUserForEmail(email: string, displayName: string | null): Promise<UserRow> {
  const normalised = email.trim().toLowerCase();
  const existing = await findUserByEmail(normalised);
  if (existing) return existing;

  const { supabaseUrl, anonKey } = getSupabaseEnv();
  const name = (displayName?.trim() || normalised.split("@")[0]).slice(0, 100);
  const password_hash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  const res = await fetch(`${supabaseUrl}/rest/v1/User`, {
    method: "POST",
    headers: {
      apikey: anonKey!,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ id: crypto.randomUUID(), name, email: normalised, password_hash }),
  });
  if (res.ok) return ((await res.json()) as UserRow[])[0];
  // 409 = another request created it first; use that row.
  if (res.status === 409) {
    const winner = await findUserByEmail(normalised);
    if (winner) return winner;
  }
  throw new Error(`User create failed (${res.status}): ${await res.text()}`);
}

/** Store a new password for the app's own email/password login. */
export async function setUserPassword(email: string, password: string): Promise<boolean> {
  const { supabaseUrl, anonKey } = getSupabaseEnv();
  if (!supabaseUrl || !anonKey) return false;
  const password_hash = await bcrypt.hash(password, 10);
  const res = await fetch(`${supabaseUrl}/rest/v1/User?email=eq.${encodeURIComponent(email.trim().toLowerCase())}`, {
    method: "PATCH",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ password_hash }),
  });
  if (!res.ok) return false;
  return ((await res.json()) as unknown[]).length > 0;
}

/** Only same-site paths: an open redirect would let a link bounce users anywhere. */
export function safeRedirectPath(value: string | null | undefined, fallback = "/scan"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}
