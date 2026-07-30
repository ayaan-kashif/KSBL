/**
 * GET /api/vouchers/mine
 *
 * The logged-in customer's vouchers with offer + partner joined, newest first.
 *
 * `expired` is computed here from expires_at rather than read off status —
 * nothing ever writes status = 'expired' (no expiry cron, see TODO-horeca.md),
 * so trusting the column would show a lapsed voucher as still active.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCustomerIdFromRequest } from "@/lib/customer";
import { supabaseConfig, restHeaders, isExpired } from "@/lib/vouchers";

export async function GET(req: NextRequest) {
  const customerId = await getCustomerIdFromRequest(req);
  if (!customerId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const config = supabaseConfig();
  if (!config) {
    return NextResponse.json({ error: "Supabase configuration is missing on server" }, { status: 500 });
  }

  try {
    const url =
      `${config.url}/rest/v1/Voucher?user_id=eq.${encodeURIComponent(customerId)}` +
      `&select=id,code,status,issued_at,expires_at,redeemed_at,` +
      `offer:RewardOffer(id,title_en,title_ur,description_en,description_ur,consumer_value_pkr,points_cost,` +
      `partner:Partner(id,name,cuisine,area,logo_url))` +
      `&order=issued_at.desc`;

    const res = await fetch(url, { headers: restHeaders(config.key), cache: "no-store" });
    if (!res.ok) {
      console.error("[GET /api/vouchers/mine] Supabase REST call failed:", res.status, await res.text());
      return NextResponse.json({ error: "Failed to load your vouchers" }, { status: 500 });
    }

    interface VoucherRow {
      id: string;
      code: string;
      status: string;
      issued_at: string;
      expires_at: string;
      redeemed_at: string | null;
      offer: unknown;
    }

    const rows = (await res.json()) as VoucherRow[];
    const vouchers = rows.map((v) => ({
      ...v,
      status: v.status === "issued" && isExpired(v.expires_at) ? "expired" : v.status,
    }));

    return NextResponse.json(vouchers, { status: 200 });
  } catch (err) {
    console.error("[GET /api/vouchers/mine] Failed:", err);
    return NextResponse.json({ error: "Failed to load your vouchers" }, { status: 500 });
  }
}
