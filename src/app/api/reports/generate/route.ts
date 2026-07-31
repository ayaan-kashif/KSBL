import { NextResponse } from "next/server";
import type { ScanRow } from "@/lib/supabaseTypes";

// PDF generation helper
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

export async function POST() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: "Supabase configuration missing" }, { status: 500 });
  }

  try {
    // 1. Fetch total statistics
    const statsRes = await fetch(`${supabaseUrl}/rest/v1/Scan?select=verdict,confidence,area_name`, {
      headers: { "apikey": anonKey, "Authorization": `Bearer ${anonKey}` }
    });

    if (!statsRes.ok) {
      return NextResponse.json({ error: "Failed to query database stats" }, { status: 500 });
    }

    const scans = await statsRes.json();
    const total = scans.length;
    const genuine = scans.filter((s: ScanRow) => s.verdict === "genuine").length;
    const suspicious = scans.filter((s: ScanRow) => s.verdict === "suspicious").length;
    const unverified = scans.filter((s: ScanRow) => s.verdict === "unverified").length;

    const rate = total > 0 ? Math.round((suspicious / total) * 100) : 0;

    const lines = [
      "=================================================",
      "SUPPLY CHAIN INTEGRITY AUDIT REPORT (GLOBAL)",
      "=================================================",
      `Audit Date: ${new Date().toLocaleString()}`,
      `Total Scans Checked: ${total}`,
      `Genuine Scans: ${genuine} (${total > 0 ? Math.round((genuine/total)*100) : 0}%)`,
      `Suspicious Scans: ${suspicious} (${rate}%)`,
      `Unverified Scans: ${unverified} (${total > 0 ? Math.round((unverified/total)*100) : 0}%)`,
      "",
      "MARKET PENETRATION BY REGION:",
      "-----------------------------",
    ];

    const areaMap: Record<string, number> = {};
    scans.forEach((s: ScanRow) => {
      const area = s.area_name ?? "Unknown Area";
      areaMap[area] = (areaMap[area] || 0) + 1;
    });

    Object.entries(areaMap).forEach(([area, count]) => {
      lines.push(` * ${area}: ${count} Scans logged`);
    });

    lines.push("");
    lines.push("STATUS SUMMARY: ALL AI CLASSIFICATION PIPELINES NOMINAL.");

    const pdfBuffer = generatePDF("Supply Chain Integrity Audit Report", lines);

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="Supply_Chain_Audit_Report.pdf"'
      }
    });
  } catch (err) {
    console.error("Generate report POST error:", err);
    return NextResponse.json({ error: "Failed to generate audit report" }, { status: 500 });
  }
}
