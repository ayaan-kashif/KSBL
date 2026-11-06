/**
 * GET /api/scans/mine
 *
 * Same shape as GET /api/scans, but scoped to the logged-in customer via
 * the customer_session cookie — kept as a separate route so the shared
 * /api/scans endpoint (used by the admin Overview/Analytics dashboards,
 * which need all scans) doesn't need a behavior change.
 *
 * Query params:
 *   limit  number  — default 20, max 100
 */

import { NextRequest, NextResponse } from "next/server";
import { getCustomerIdFromRequest } from "@/lib/customer";

export async function GET(req: NextRequest) {
  const customerId = await getCustomerIdFromRequest(req);
  if (!customerId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 20, 100) : 20;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { error: "Supabase configuration is missing on server" },
      { status: 500 }
    );
  }

  try {
    const fetchUrl =
      `${supabaseUrl}/rest/v1/Scan?customer_id=eq.${encodeURIComponent(customerId)}` +
      `&select=*,product:Product(product_name,brand_name)&order=created_at.desc&limit=${limit}`;
    const res = await fetch(fetchUrl, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[GET /api/scans/mine] Supabase REST call failed:", res.status, errText);
      return NextResponse.json({ error: "Failed to fetch scan history" }, { status: 500 });
    }

    interface ScanRow {
      id: string;
      verdict: string;
      confidence: number;
      area_name: string | null;
      product_name: string | null;
      brand_name: string | null;
      extracted_batch: string | null;
      image_url: string;
      created_at: string;
      category?: string | null;
      expiry_date?: string | null;
      product?: { product_name: string | null; brand_name: string | null } | null;
    }

    const scans: ScanRow[] = await res.json();
    const result = scans.map((s) => ({
      id: s.id,
      verdict: s.verdict,
      confidence: s.confidence,
      area_name: s.area_name,
      product_name: s.product?.product_name ?? s.product_name ?? null,
      brand_name: s.product?.brand_name ?? s.brand_name ?? null,
      extracted_batch: s.extracted_batch,
      image_url: s.image_url,
      created_at: s.created_at,
      // Additive: lets history label a medicine "No red flags found" instead
      // of "Genuine", and show its expiry. Both null for food scans.
      category: s.category ?? null,
      expiry_date: s.category === "Medicine" ? s.expiry_date ?? null : null,
    }));

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("[GET /api/scans/mine] Failed to fetch scan history:", err);
    return NextResponse.json({ error: "Failed to load scan history" }, { status: 500 });
  }
}
