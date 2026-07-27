/**
 * GET /api/auth/me
 *
 * Returns the logged-in customer's profile (including live score_points),
 * or { authenticated: false } if there's no valid customer_session cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCustomerIdFromRequest } from "@/lib/customer";
import { getSupabaseEnv } from "@/lib/supabaseEnv";

export async function GET(req: NextRequest) {
  const customerId = await getCustomerIdFromRequest(req);
  if (!customerId) {
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }

  const { supabaseUrl, anonKey } = getSupabaseEnv();
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/User?id=eq.${encodeURIComponent(customerId)}&select=id,name,email,score_points`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } }
    );
    if (!res.ok) return NextResponse.json({ authenticated: false }, { status: 200 });

    const rows = await res.json();
    if (!rows || rows.length === 0) {
      return NextResponse.json({ authenticated: false }, { status: 200 });
    }

    return NextResponse.json({ authenticated: true, ...rows[0] }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/auth/me] Failed:", err);
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }
}
