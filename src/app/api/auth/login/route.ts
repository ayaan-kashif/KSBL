/**
 * POST /api/auth/login
 *
 * Checks email + password against the User table and, on success, sets the
 * "customer_session" httpOnly cookie.
 *
 * Request (application/json): { email, password }
 * Response 200: { id, name, email, score_points }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { signCustomerSession, CUSTOMER_SESSION_COOKIE } from "@/lib/auth";
import { getSupabaseEnv } from "@/lib/supabaseEnv";

const LoginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const { supabaseUrl, anonKey } = getSupabaseEnv();
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "Server configuration is missing" }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 422 });
  }
  const email = parsed.data.email.toLowerCase();
  const { password } = parsed.data;

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/User?email=eq.${encodeURIComponent(email)}&select=id,name,email,password_hash,score_points`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } }
    );
    if (!res.ok) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }
    const rows = await res.json();
    const user = rows?.[0];

    // Generic error for both "no such user" and "wrong password" — avoids
    // leaking which emails have accounts.
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }

    const token = await signCustomerSession({ sub: user.id, email: user.email, name: user.name });

    const response = NextResponse.json(
      { id: user.id, name: user.name, email: user.email, score_points: user.score_points ?? 0 },
      { status: 200 }
    );
    response.cookies.set(CUSTOMER_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return response;
  } catch (err) {
    console.error("[POST /api/auth/login] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
