/**
 * GET /api/partners/stats
 *
 * Aggregates for the dashboard's HORECA tile: vouchers redeemed, consumer
 * value delivered, bulk product credit issued (the B2B pull-through figure),
 * and the top 3 partners by redemption count.
 *
 * Totals are summed from redeemed vouchers rather than read off
 * Partner.bulk_credit_issued_pkr, so the tile stays correct even if a credit
 * increment was lost to the non-atomic write in /api/partner/redeem.
 */

import { NextResponse } from "next/server";
import { supabaseConfig, restHeaders } from "@/lib/vouchers";

export async function GET() {
  const config = supabaseConfig();
  if (!config) {
    return NextResponse.json({ error: "Supabase configuration is missing on server" }, { status: 500 });
  }

  try {
    const url =
      `${config.url}/rest/v1/Voucher?status=eq.redeemed` +
      `&select=id,redeemed_at,offer:RewardOffer(consumer_value_pkr,bulk_credit_pkr,partner:Partner(id,name,area,cuisine))`;

    const res = await fetch(url, { headers: restHeaders(config.key), cache: "no-store" });
    if (!res.ok) {
      console.error("[GET /api/partners/stats] Supabase REST call failed:", res.status, await res.text());
      return NextResponse.json({ error: "Failed to load partner stats" }, { status: 500 });
    }

    interface RedeemedRow {
      id: string;
      redeemed_at: string | null;
      offer: {
        consumer_value_pkr: number;
        bulk_credit_pkr: number;
        partner: { id: string; name: string; area: string; cuisine: string } | null;
      } | null;
    }

    const rows = (await res.json()) as RedeemedRow[];

    let consumerValue = 0;
    let bulkCredit = 0;
    const byPartner = new Map<
      string,
      { partner_id: string; name: string; area: string; redemptions: number; bulk_credit_pkr: number }
    >();

    for (const row of rows) {
      const offer = row.offer;
      if (!offer) continue;
      consumerValue += offer.consumer_value_pkr ?? 0;
      bulkCredit += offer.bulk_credit_pkr ?? 0;

      const partner = offer.partner;
      if (!partner) continue;
      const entry = byPartner.get(partner.id) ?? {
        partner_id: partner.id,
        name: partner.name,
        area: partner.area,
        redemptions: 0,
        bulk_credit_pkr: 0,
      };
      entry.redemptions += 1;
      entry.bulk_credit_pkr += offer.bulk_credit_pkr ?? 0;
      byPartner.set(partner.id, entry);
    }

    const topPartners = [...byPartner.values()]
      .sort((a, b) => b.redemptions - a.redemptions || b.bulk_credit_pkr - a.bulk_credit_pkr)
      .slice(0, 3);

    return NextResponse.json(
      {
        vouchers_redeemed: rows.length,
        consumer_value_pkr: consumerValue,
        bulk_credit_pkr: bulkCredit,
        top_partners: topPartners,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[GET /api/partners/stats] Failed:", err);
    return NextResponse.json({ error: "Failed to load partner stats" }, { status: 500 });
  }
}
