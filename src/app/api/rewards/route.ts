/**
 * GET /api/rewards
 *
 * Active reward offers with their partner joined, for the /rewards catalog.
 * Public — the catalog is browsable logged-out; only redemption needs a session.
 */

import { NextResponse } from "next/server";
import { supabaseConfig, restHeaders } from "@/lib/vouchers";

export interface RewardOfferRow {
  id: string;
  title_en: string;
  title_ur: string;
  description_en: string;
  description_ur: string;
  points_cost: number;
  consumer_value_pkr: number;
  bulk_credit_pkr: number;
  partner: {
    id: string;
    name: string;
    cuisine: string;
    area: string;
    logo_url: string | null;
  } | null;
}

export async function GET() {
  const config = supabaseConfig();
  if (!config) {
    return NextResponse.json({ error: "Supabase configuration is missing on server" }, { status: 500 });
  }

  try {
    const url =
      `${config.url}/rest/v1/RewardOffer?active=eq.true` +
      `&select=id,title_en,title_ur,description_en,description_ur,points_cost,consumer_value_pkr,bulk_credit_pkr,` +
      `partner:Partner!inner(id,name,cuisine,area,logo_url)` +
      `&partner.active=eq.true&order=points_cost.asc`;

    const res = await fetch(url, { headers: restHeaders(config.key), cache: "no-store" });
    if (!res.ok) {
      console.error("[GET /api/rewards] Supabase REST call failed:", res.status, await res.text());
      return NextResponse.json({ error: "Failed to load rewards" }, { status: 500 });
    }

    const offers = (await res.json()) as RewardOfferRow[];
    return NextResponse.json(offers, { status: 200 });
  } catch (err) {
    console.error("[GET /api/rewards] Failed:", err);
    return NextResponse.json({ error: "Failed to load rewards" }, { status: 500 });
  }
}
