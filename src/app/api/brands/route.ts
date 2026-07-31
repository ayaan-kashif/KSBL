/**
 * GET /api/brands
 *
 * Admin-only. Returns every brand (id + name) for the analytics brand
 * selector, which previously shipped a hardcoded two-entry demo list — so any
 * brand added to the database was invisible in the console.
 *
 * Only id and name are exposed: Brand also holds contact_email and
 * subscription_tier, neither of which the selector needs.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySession, ADMIN_SESSION_COOKIE, type AdminSessionPayload } from "@/lib/auth";
import { getSupabaseEnv } from "@/lib/supabaseEnv";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  const session = token ? await verifySession<AdminSessionPayload>(token) : null;
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { supabaseUrl, anonKey } = getSupabaseEnv();
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { error: "Supabase configuration is missing on server" },
      { status: 500 }
    );
  }

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/Brand?select=id,name&order=name.asc`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("[GET /api/brands] Supabase REST call failed:", res.status, errText);
      return NextResponse.json({ error: "Failed to load brands" }, { status: 500 });
    }

    const brands = await res.json();
    return NextResponse.json(brands, { status: 200 });
  } catch (err) {
    console.error("[GET /api/brands] Failed:", err);
    return NextResponse.json({ error: "Failed to load brands" }, { status: 500 });
  }
}
