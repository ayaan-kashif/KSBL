import { NextResponse } from "next/server";
import type { ScanRow } from "@/lib/supabaseTypes";
import { formatConfidencePct, formatScanDate } from "@/lib/supabaseTypes";

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "Supabase configuration missing" }, { status: 500 });
  }

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/Scan?order=created_at.desc&select=*,product:Product(product_name,brand_name)`, {
      headers: { "apikey": anonKey, "Authorization": `Bearer ${anonKey}` }
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Failed to fetch scans for export" }, { status: 500 });
    }

    const scans = await res.json();
    let csv = "Scan ID,Scanned By,Product Name,Brand Name,Verdict,Confidence,Area,Latitude,Longitude,Date\n";
    scans.forEach((s: ScanRow) => {
      const pName = (s.product?.product_name ?? s.product_name ?? "Unknown").replace(/,/g, " ");
      const bName = (s.product?.brand_name ?? s.brand_name ?? "Unknown").replace(/,/g, " ");
      const area = (s.area_name ?? "Karachi").replace(/,/g, " ");
      const conf = formatConfidencePct(s.confidence);
      const date = formatScanDate(s.created_at);
      csv += `${s.id},${s.scanned_by_role},${pName},${bName},${s.verdict},${conf},${area},${s.latitude || ""},${s.longitude || ""},${date}\n`;
    });

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="ShelfWatch_All_Scans_Export.csv"'
      }
    });
  } catch (err) {
    console.error("Export all scans error:", err);
    return NextResponse.json({ error: "Failed to export scan data" }, { status: 500 });
  }
}
