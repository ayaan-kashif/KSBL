/**
 * GET /api/dashboard/stats?brand_id=...&from=...&to=...
 *
 * Returns aggregate scan/report statistics for a brand.
 *
 * Consumer data is anonymized: individual lat/long and scanned_by_role
 * are NOT returned — only aggregated counts and rates.
 *
 * Query params:
 *   brand_id   string   — required
 *   from       ISO date — optional (default: 30 days ago)
 *   to         ISO date — optional (default: now)
 *
 * Response 200:
 *   {
 *     total_scans, genuine_count, suspicious_count, unverified_count,
 *     suspicious_rate, estimated_losses_pkr, date_range: { from, to }
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { ProductRow, ScanRow } from "@/lib/supabaseTypes";

const QuerySchema = z.object({
  brand_id: z.string().min(1, "brand_id is required"),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

// Average unit price used when product avg_unit_price_pkr = 0
const FALLBACK_UNIT_PRICE_PKR = 150;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const parsed = QuerySchema.safeParse({
    brand_id: searchParams.get("brand_id"),
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query params", details: parsed.error.flatten() },
      { status: 422 }
    );
  }

  const { brand_id } = parsed.data;
  const from = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = parsed.data.to ? new Date(parsed.data.to) : new Date();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { error: "Supabase configuration is missing on server" },
      { status: 500 }
    );
  }

  try {
    // 1. Verify brand exists
    const brandRes = await fetch(`${supabaseUrl}/rest/v1/Brand?id=eq.${brand_id}`, {
      method: "GET",
      headers: {
        "apikey": anonKey,
        "Authorization": `Bearer ${anonKey}`
      }
    });

    if (!brandRes.ok) {
      return NextResponse.json({ error: "Failed to verify brand" }, { status: 500 });
    }

    const brandData = await brandRes.json();
    if (!brandData || brandData.length === 0) {
      return NextResponse.json({ error: "Brand not found" }, { status: 404 });
    }
    // 2. Find all product IDs for this brand
    const productsRes = await fetch(
      `${supabaseUrl}/rest/v1/Product?brand_name=eq.${encodeURIComponent(brandData[0].name)}&select=id,avg_unit_price_pkr`,
      {
        method: "GET",
        headers: {
          "apikey": anonKey,
          "Authorization": `Bearer ${anonKey}`
        }
      }
    );

    const productIds: string[] = [];
    const productPriceMap = new Map<string, number>();
    if (productsRes.ok) {
      const products = await productsRes.json();
      products.forEach((p: ProductRow) => {
        if (p.id) {
          productIds.push(p.id);
          productPriceMap.set(p.id, p.avg_unit_price_pkr ?? 0);
        }
      });
    }

    // 3. Query all scans for this brand in the date range
    let filter = `brand_name=eq.${encodeURIComponent(brandData[0].name)}`;
    if (productIds.length > 0) {
      filter = `or=(brand_name.eq.${encodeURIComponent(brandData[0].name)},product_id.in.(${productIds.join(',')}))`;
    }

    const scansRes = await fetch(
      `${supabaseUrl}/rest/v1/Scan?${filter}&created_at=gte.${from.toISOString()}&created_at=lte.${to.toISOString()}&select=verdict,product_id`,
      {
        method: "GET",
        headers: {
          "apikey": anonKey,
          "Authorization": `Bearer ${anonKey}`
        }
      }
    );

    if (!scansRes.ok) {
      const errText = await scansRes.text();
      console.error("[GET /api/dashboard/stats] Failed to fetch scans:", scansRes.status, errText);
      return NextResponse.json({ error: "Failed to fetch scans" }, { status: 500 });
    }

    const scans = await scansRes.json();

    const total_scans = scans.length;
    const genuine_count = scans.filter((s: ScanRow) => s.verdict === "genuine").length;
    const suspicious_count = scans.filter((s: ScanRow) => s.verdict === "suspicious").length;
    const unverified_count = scans.filter((s: ScanRow) => s.verdict === "unverified").length;
    const suspicious_rate = total_scans > 0 ? suspicious_count / total_scans : 0;

    // 4. Calculate estimated losses based on unit prices
    let estimated_losses_pkr = 0;
    scans.forEach((s: ScanRow) => {
      if (s.verdict === "suspicious") {
        const price = s.product_id ? (productPriceMap.get(s.product_id) || FALLBACK_UNIT_PRICE_PKR) : FALLBACK_UNIT_PRICE_PKR;
        estimated_losses_pkr += price;
      }
    });

    return NextResponse.json({
      total_scans,
      genuine_count,
      suspicious_count,
      unverified_count,
      suspicious_rate: Math.round(suspicious_rate * 10000) / 100, // percentage, 2dp
      estimated_losses_pkr: Math.round(estimated_losses_pkr),
      date_range: { from: from.toISOString(), to: to.toISOString() },
    });
  } catch (err) {
    console.error("[GET /api/dashboard/stats] Failed to fetch stats:", err);
    return NextResponse.json(
      { error: "Failed to load dashboard statistics" },
      { status: 500 }
    );
  }
}
