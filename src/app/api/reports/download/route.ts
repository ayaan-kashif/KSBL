import { NextRequest, NextResponse } from "next/server";
import type { ProductRow, ScanRow } from "@/lib/supabaseTypes";
import { formatConfidencePct, formatScanDate, shortId } from "@/lib/supabaseTypes";

// Simple PDF generation helper that returns a valid, repairable basic PDF structure
function generatePDF(title: string, dataLines: string[]): Buffer {
  const contentStream = [
    "BT",
    "/F1 18 Tf",
    "70 700 Td",
    `(${title}) Tj`,
    "0 -30 Td",
    "/F1 11 Tf",
    ...dataLines.map(line => `(${line.replace(/[()]/g, "")}) Tj 0 -18 Td`),
    "ET"
  ].join("\n");

  const streamBytes = Buffer.from(contentStream, "utf-8");

  const pdfParts = [
    "%PDF-1.4\n",
    "1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n",
    "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n",
    "3 0 obj\n<</Type /Page /Parent 2 0 R /Resources <</Font <</F1 4 0 R>>>> /MediaBox [0 0 612 792] /Contents 5 0 R>>\nendobj\n",
    "4 0 obj\n<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>\nendobj\n",
    `5 0 obj\n<</Length ${streamBytes.length}>>\nstream\n`,
    streamBytes,
    "\nendstream\nendobj\n",
    "xref\n0 6\n0000000000 65535 f \n",
    "trailer\n<</Size 6 /Root 1 0 R>>\n",
    "startxref\n",
    "%%EOF\n"
  ];

  return Buffer.concat(pdfParts.map(p => typeof p === "string" ? Buffer.from(p, "utf-8") : p));
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const idStr = searchParams.get("id");
  if (!idStr) {
    return NextResponse.json({ error: "Missing report ID" }, { status: 400 });
  }

  const id = parseInt(idStr);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "Supabase configuration missing" }, { status: 500 });
  }

  async function fetchScans(query: string = "") {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/Scan?${query}`, {
        headers: { "apikey": anonKey!, "Authorization": `Bearer ${anonKey!}` }
      });
      return res.ok ? await res.json() : [];
    } catch {
      return [];
    }
  }

  try {
    if (id === 1) {
      // Monthly Counterfeit Summary (PDF)
      const scans = await fetchScans("verdict=eq.suspicious&limit=20&select=*,product:Product(product_name,brand_name)");
      const lines = [
        "=================================================",
        "COUNTERFEIT SUMMARY - ALL RECORDED SCANS",
        "=================================================",
        `Report Generated: ${new Date().toLocaleString()}`,
        `Total Counterfeit Scans Logged: ${scans.length}`,
        "",
        "ID | Product | Brand | Area | Conf. | Date",
        "-------------------------------------------------"
      ];

      scans.forEach((s: ScanRow) => {
        const pName = s.product?.product_name ?? s.product_name ?? "Unknown";
        const bName = s.product?.brand_name ?? s.brand_name ?? "Unknown";
        const area = s.area_name ?? "Karachi";
        const conf = formatConfidencePct(s.confidence);
        const date = formatScanDate(s.created_at);
        lines.push(`${shortId(s.id)} | ${pName} | ${bName} | ${area} | ${conf} | ${date}`);
      });

      const pdfBuffer = generatePDF("Monthly Counterfeit Summary", lines);
      return new NextResponse(new Uint8Array(pdfBuffer), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="Monthly_Counterfeit_Summary.pdf"'
        }
      });
    } else if (id === 2) {
      // Field Agent Audit Trail (CSV)
      const scans = await fetchScans("limit=50&select=*,product:Product(product_name,brand_name)");
      let csv = "Scan ID,Scanned By,Product Name,Brand Name,Verdict,Confidence,Area,Date\n";
      scans.forEach((s: ScanRow) => {
        const pName = (s.product?.product_name ?? s.product_name ?? "Unknown").replace(/,/g, " ");
        const bName = (s.product?.brand_name ?? s.brand_name ?? "Unknown").replace(/,/g, " ");
        const area = (s.area_name ?? "Karachi").replace(/,/g, " ");
        const conf = formatConfidencePct(s.confidence);
        const date = formatScanDate(s.created_at);
        csv += `${s.id},${s.scanned_by_role},${pName},${bName},${s.verdict},${conf},${area},${date}\n`;
      });

      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="Field_Agent_Audit_Trail.csv"'
        }
      });
    } else if (id === 3) {
      // Regional Hotspot Analysis (PDF)
      const scans = await fetchScans("latitude=not.is.null&longitude=not.is.null&select=area_name,verdict");
      const areaMap: Record<string, { total: number, suspicious: number }> = {};
      scans.forEach((s: ScanRow) => {
        const area = s.area_name ?? "Karachi";
        if (!areaMap[area]) areaMap[area] = { total: 0, suspicious: 0 };
        areaMap[area].total++;
        if (s.verdict === "suspicious") areaMap[area].suspicious++;
      });

      const lines = [
        "=================================================",
        "REGIONAL HOTSPOT ANALYSIS - ALL RECORDED SCANS",
        "=================================================",
        `Report Generated: ${new Date().toLocaleString()}`,
        "",
        "Area Name | Total Scans | Suspicious Scans | Suspicious Rate",
        "-------------------------------------------------------------"
      ];

      Object.entries(areaMap).forEach(([area, data]) => {
        const rate = `${Math.round((data.suspicious / data.total) * 100)}%`;
        lines.push(`${area} | ${data.total} | ${data.suspicious} | ${rate}`);
      });

      const pdfBuffer = generatePDF("Regional Hotspot Analysis", lines);
      return new NextResponse(new Uint8Array(pdfBuffer), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="Regional_Hotspot_Analysis.pdf"'
        }
      });
    } else if (id === 4) {
      // Brand Integrity Score Report (CSV)
      const scans = await fetchScans("select=verdict,product_id,product:Product(brand_name),brand_name");
      const brandMap: Record<string, { total: number, genuine: number }> = {};
      scans.forEach((s: ScanRow) => {
        const bName = s.product?.brand_name ?? s.brand_name ?? "Unknown Brand";
        if (!brandMap[bName]) brandMap[bName] = { total: 0, genuine: 0 };
        brandMap[bName].total++;
        if (s.verdict === "genuine") brandMap[bName].genuine++;
      });

      let csv = "Brand Name,Total Scans,Genuine Scans,Integrity Score\n";
      Object.entries(brandMap).forEach(([brand, data]) => {
        const score = `${Math.round((data.genuine / data.total) * 100)}%`;
        csv += `${brand},${data.total},${data.genuine},${score}\n`;
      });

      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="Brand_Integrity_Score_Report.csv"'
        }
      });
    } else if (id === 5) {
      // Verification Pipeline Metrics (PDF).
      //
      // This used to emit invented model-quality figures ("Logo Match Accuracy
      // 92.4% -> 94.8%", "False Positive Rate 4.2%") as a downloadable PDF a
      // brand could act on. None of it was measurable: accuracy and false-
      // positive rate need ground truth about whether a verdict was CORRECT,
      // and nothing in the schema records that — no reviewer confirmation, no
      // adjudication column.
      //
      // Everything below is computed from the Scan table instead: how the
      // pipeline's verdicts are distributed, how confident it was, and how
      // often each extraction stage produced a value. Those are real
      // throughput metrics, and they are labelled as such.
      // Only the columns this report selects, so the aggregation below is
      // type-checked rather than riding on `any` like the older branches.
      interface MetricRow {
        verdict: string | null;
        confidence: number | null;
        barcode: string | null;
        extracted_batch: string | null;
        cv_anomaly_score: number | null;
      }

      const scans: MetricRow[] = await fetchScans(
        "select=verdict,confidence,barcode,extracted_batch,cv_anomaly_score"
      );

      const total = scans.length;
      const pct = (n: number) => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "n/a");
      const countBy = (fn: (s: MetricRow) => boolean) => scans.filter(fn).length;

      const genuine = countBy((s) => s.verdict === "genuine");
      const suspicious = countBy((s) => s.verdict === "suspicious");
      const unverified = countBy((s) => s.verdict === "unverified");
      const withBarcode = countBy((s) => s.barcode != null && s.barcode !== "");
      const withBatch = countBy((s) => s.extracted_batch != null && s.extracted_batch !== "");
      const withCv = countBy((s) => s.cv_anomaly_score != null);

      const avg = (vals: number[]) =>
        vals.length > 0
          ? `${((vals.reduce((a, b) => a + b, 0) / vals.length) * 100).toFixed(1)}%`
          : "n/a";
      const confOf = (verdict?: string) =>
        avg(
          scans
            .filter((s) => (verdict ? s.verdict === verdict : true))
            .map((s) => s.confidence ?? 0)
        );
      const confAll = confOf();
      const confGenuine = confOf("genuine");
      const confSuspicious = confOf("suspicious");

      const lines = [
        "=================================================",
        "VERIFICATION PIPELINE METRICS",
        "=================================================",
        `Report Generated: ${new Date().toLocaleString()}`,
        `Scans Analysed: ${total}`,
        "",
        "NOTE: These are throughput and confidence metrics measured from",
        "logged scans. They are NOT model accuracy - confirming whether a",
        "verdict was correct requires ground-truth review, which this system",
        "does not currently record.",
        "",
        "VERDICT DISTRIBUTION",
        "-------------------------------------------------",
        `Genuine | ${genuine} | ${pct(genuine)}`,
        `Suspicious | ${suspicious} | ${pct(suspicious)}`,
        `Unverified | ${unverified} | ${pct(unverified)}`,
        `Resolved (non-unverified) | ${total - unverified} | ${pct(total - unverified)}`,
        "",
        "MEAN CONFIDENCE",
        "-------------------------------------------------",
        `All scans | ${confAll}`,
        `Genuine verdicts | ${confGenuine}`,
        `Suspicious verdicts | ${confSuspicious}`,
        "",
        "EXTRACTION COVERAGE",
        "-------------------------------------------------",
        `Barcode captured | ${withBarcode} | ${pct(withBarcode)}`,
        `Batch code read (OCR) | ${withBatch} | ${pct(withBatch)}`,
        `Packaging scored (CV) | ${withCv} | ${pct(withCv)}`,
      ];

      const pdfBuffer = generatePDF("Verification Pipeline Metrics", lines);
      return new NextResponse(new Uint8Array(pdfBuffer), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="Verification_Pipeline_Metrics.pdf"'
        }
      });
    } else if (id === 6) {
      // Recalled Products Master List (CSV)
      const prodRes = await fetch(`${supabaseUrl}/rest/v1/Product?select=*`, {
        headers: { "apikey": anonKey, "Authorization": `Bearer ${anonKey}` }
      });
      let csv = "Product ID,SKU,Product Name,Brand Name,Avg Unit Price (PKR)\n";
      if (prodRes.ok) {
        const products = await prodRes.json();
        // `?? ""` before .replace: a product row with a null name or brand
        // used to throw here and fail the whole export.
        products.forEach((p: ProductRow) => {
          const name = (p.product_name ?? "").replace(/,/g, " ");
          const brand = (p.brand_name ?? "").replace(/,/g, " ");
          csv += `${p.id ?? ""},${p.sku ?? ""},${name},${brand},${p.avg_unit_price_pkr ?? 0}\n`;
        });
      }

      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="Recalled_Products_Master_List.csv"'
        }
      });
    }

    return NextResponse.json({ error: "Invalid report ID" }, { status: 400 });
  } catch (err) {
    console.error("Report download error:", err);
    return NextResponse.json({ error: "Server error generating report" }, { status: 500 });
  }
}
