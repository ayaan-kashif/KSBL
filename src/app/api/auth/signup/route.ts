/**
 * POST /api/auth/signup
 *
 * Creates a new customer account and logs them in immediately by setting
 * the "customer_session" httpOnly cookie.
 *
 * Request (application/json): { name, email, password }
 * Response 201: { id, name, email, score_points }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { signCustomerSession, CUSTOMER_SESSION_COOKIE } from "@/lib/auth";
import { getSupabaseEnv } from "@/lib/supabaseEnv";

const SignupSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(200),
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

  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 422 }
    );
  }

  const { name, password } = parsed.data;
  const email = parsed.data.email.toLowerCase();

  try {
    const existingRes = await fetch(
      `${supabaseUrl}/rest/v1/User?email=eq.${encodeURIComponent(email)}&select=id`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } }
    );
    if (existingRes.ok) {
      const existing = await existingRes.json();
      if (existing && existing.length > 0) {
        return NextResponse.json(
          { error: "An account with this email already exists" },
          { status: 409 }
        );
      }
    }

    const password_hash = await bcrypt.hash(password, 10);

    const createRes = await fetch(`${supabaseUrl}/rest/v1/User`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ id: crypto.randomUUID(), name, email, password_hash }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error("[POST /api/auth/signup] Failed to create user:", createRes.status, errText);
      return NextResponse.json({ error: "Failed to create account" }, { status: 500 });
    }

    const created = await createRes.json();
    const user = created[0];

    const token = await signCustomerSession({ sub: user.id, email: user.email, name: user.name });

    const res = NextResponse.json(
      { id: user.id, name: user.name, email: user.email, score_points: user.score_points ?? 0 },
      { status: 201 }
    );
    res.cookies.set(CUSTOMER_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return res;
  } catch (err) {
    console.error("[POST /api/auth/signup] Unhandled error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
