/**
 * GET /api/scans
 *
 * Returns a list of recent scans for the history page.
 * Includes matched product and brand information.
 *
 * Query params:
 *   limit  number  — default 20, max 100
 *
 * Response 200:
 *   Array<{ id, verdict, confidence, area_name, product_name, brand_name, extracted_batch, image_url, created_at }>
 */

import { NextRequest, NextResponse } from "next/server";
import type { ScanRow } from "@/lib/supabaseTypes";

export async function GET(req: NextRequest) {
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
    const fetchUrl = `${supabaseUrl}/rest/v1/Scan?select=*,product:Product(product_name,brand_name)&order=created_at.desc&limit=${limit}`;
    const res = await fetch(fetchUrl, {
      method: "GET",
      headers: {
        "apikey": anonKey,
        "Authorization": `Bearer ${anonKey}`
      }
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[GET /api/scans] Supabase REST call failed:", res.status, errText);
      return NextResponse.json({ error: "Failed to fetch scan history from database" }, { status: 500 });
    }

    const scans = await res.json();

    const result = scans.map((s: ScanRow) => ({
      id: s.id,
      verdict: s.verdict,
      confidence: s.confidence,
      area_name: s.area_name,
      product_name: s.product?.product_name ?? s.product_name ?? null,
      brand_name: s.product?.brand_name ?? s.brand_name ?? null,
      category: s.category ?? null,
      barcode: s.barcode ?? null,
      extracted_batch: s.extracted_batch,
      image_url: s.image_url,
      created_at: s.created_at,
      ai_flags: s.ocr_raw_json ?? null,
    }));

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("[GET /api/scans] Failed to fetch scan history:", err);
    return NextResponse.json(
      { error: "Failed to load scan history" },
      { status: 500 }
    );
  }
}
