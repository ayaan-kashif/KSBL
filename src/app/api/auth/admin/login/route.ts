/**
 * POST /api/auth/admin/login
 *
 * Checks the submitted credentials against the Admin table and, on success,
 * sets the "admin_session" httpOnly cookie. Any row in the Admin table can
 * log in — add more rows to share portal access with other users.
 *
 * Request (application/json): { email, password }
 * Response 200: { ok: true, email }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { signAdminSession, ADMIN_SESSION_COOKIE } from "@/lib/auth";
import { db } from "@/lib/db";

const AdminLoginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AdminLoginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 422 });
  }
  const { email, password } = parsed.data;

  const admin = await db.admin.findUnique({ where: { email: email.toLowerCase() } });
  const passwordMatches = admin && (await bcrypt.compare(password, admin.password_hash));

  if (!admin || !passwordMatches) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const token = await signAdminSession({ email: admin.email });
  const res = NextResponse.json({ ok: true, email: admin.email });
  res.cookies.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
}
