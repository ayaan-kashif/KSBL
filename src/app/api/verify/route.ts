/**
 * POST /api/verify
 *
 * Real product authenticity verification endpoint.
 * Runs barcode scanner (Gemini fallback), queries external DB APIs (UPCItemDB, Open Food Facts, Barcode Lookup),
 * performs side-by-side Gemini visual comparison, calculates authenticity score, and returns structured data.
 */

import { NextRequest, NextResponse } from "next/server";

// Bypass self-signed SSL/TLS certificate chain checks for Postgres database globally in this context
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import { scanBarcodeFromImage } from "@/services/barcodeScanner";
import { UnifiedProduct } from "@/services/cacheService";
import { uploadImage } from "@/lib/blob";
import { getCustomerIdFromRequest, incrementCustomerScore } from "@/lib/customer";
import { getVerdictTextSync } from "@/lib/translate";
import { resolveBrandContext } from "@/services/brandRouter";
import {
  runNationalRagPath,
  runExternalDbPath,
  type VerificationPath,
} from "@/services/verificationPaths";
/** Maps a row from our own local "Product" table (sku, brand_name, product_name,
 * reference_image_url, pack_size...) to the same shape used everywhere else
 * (UnifiedProduct) — local catalog and scraper-matched rows share this shape
 * since they both come from the same table, just via different lookup paths. */
function mapLocalProductToUnified(p: {
  product_name: string;
  brand_name: string;
  sku: string;
  pack_size?: string | null;
  reference_image_url?: string | null;
}): UnifiedProduct {
  return {
    name: p.product_name,
    brand: p.brand_name,
    manufacturer: p.brand_name,
    category: "Registered Product",
    barcode: p.sku,
    size: p.pack_size || "Standard",
    referenceImage: p.reference_image_url || "",
  };
}

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "ShelfWatch/1.0 (contact: support@shelfwatch.local)"
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.address) {
        const addr = data.address;
        const area = addr.neighbourhood || addr.suburb || addr.city_district || addr.road || addr.county || addr.city || "Unknown Location";
        return area;
      }
    }
  } catch (err) {
    console.error("[VerifyAPI] Reverse geocoding error:", err);
  }

  // Fallback boundary match for Karachi coordinates
  const KARACHI_AREAS = [
    { name: "Korangi Industrial Area", lat: 24.8338, lng: 67.1035 },
    { name: "Liaquatabad", lat: 24.9158, lng: 67.0431 },
    { name: "SITE Area", lat: 24.9087, lng: 66.9989 },
    { name: "Orangi Town", lat: 24.9495, lng: 67.0142 },
    { name: "Clifton", lat: 24.8138, lng: 67.0336 },
    { name: "Gulshan-e-Iqbal", lat: 24.9180, lng: 67.0970 },
    { name: "Saddar", lat: 24.8608, lng: 67.0104 }
  ];

  let bestArea = KARACHI_AREAS[0].name;
  let minDist = Infinity;
  for (const a of KARACHI_AREAS) {
    const dist = Math.hypot(a.lat - lat, a.lng - lng);
    if (dist < minDist) {
      minDist = dist;
      bestArea = a.name;
    }
  }
  return bestArea;
}

export async function POST(req: NextRequest) {
  try {
    const customerId = await getCustomerIdFromRequest(req);

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json(
        { error: "Invalid request format — expected multipart/form-data" },
        { status: 400 }
      );
    }

    // 1. Read input image(s) and barcode. The back photo is optional — most
    // FMCG barcodes and batch/expiry print are on the back/label panel, so
    // when it's provided it's used as a secondary barcode-read source and
    // passed to Gemini alongside the front photo for a fuller comparison.
    const imageFile = formData.get("capturedImage") || formData.get("image");
    const backImageFile = formData.get("capturedImageBack");
    let barcode = formData.get("barcode") as string | null;

    if (!imageFile || typeof imageFile === "string") {
      return NextResponse.json(
        { error: "Missing required parameter: capturedImage (File)" },
        { status: 400 }
      );
    }

    // Convert file(s) to base64 for scanning and Gemini Vision
    const arrayBuffer = await imageFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const imageBase64 = buffer.toString("base64");
    const mimeType = imageFile.type || "image/jpeg";

    let backImageBase64: string | null = null;
    let backMimeType: string | null = null;
    if (backImageFile && typeof backImageFile !== "string") {
      const backArrayBuffer = await backImageFile.arrayBuffer();
      backImageBase64 = Buffer.from(backArrayBuffer).toString("base64");
      backMimeType = backImageFile.type || "image/jpeg";
    }

    // 2. Barcode Scanning Fallback (if not passed directly) — try the front
    // photo first, then the back photo if the front didn't have a readable one.
    if (!barcode || barcode.trim() === "") {
      console.log("[VerifyAPI] No barcode provided in request. Running visual scanner...");
      barcode = await scanBarcodeFromImage(imageBase64, mimeType);
      console.log(`[VerifyAPI] Visual scanner result (front): ${barcode}`);

      if (!barcode && backImageBase64 && backMimeType) {
        barcode = await scanBarcodeFromImage(backImageBase64, backMimeType);
        console.log(`[VerifyAPI] Visual scanner result (back): ${barcode}`);
      }
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    // Upload image early — needed for the vector/scraper-catalog match below,
    // and for the DB scan record either way.
    const filename = `scan-${Date.now()}.jpg`;
    let imageUrl: string;
    try {
      imageUrl = await uploadImage(filename, imageFile);
    } catch (err) {
      console.error("[VerifyAPI] Image upload failed:", err);
      imageUrl = `https://placeholder.shelfwatch.pk/scan/${filename}`;
    }

    // 3. Identify the product. Our own catalog (local barcode/SKU match, or a
    // scraper-catalog visual match) is authoritative and checked first — it's
    // the same data Gemini should compare against and the same data the
    // result screen should display, so this single lookup feeds everything
    // downstream instead of leaving the UI showing "Unregistered/Unknown"
    // for a scan that was actually identified.
    let localProductRow: { id: string; product_name: string; brand_name: string; sku: string; pack_size?: string | null; reference_image_url?: string | null } | null = null;
    let dbProductId: string | null = null;

    if (barcode && supabaseUrl && anonKey) {
      try {
        const prodRes = await fetch(`${supabaseUrl}/rest/v1/Product?sku=eq.${encodeURIComponent(barcode.trim())}&select=*`, {
          headers: { "apikey": anonKey, "Authorization": `Bearer ${anonKey}` }
        });
        if (prodRes.ok) {
          const prodData = await prodRes.json();
          if (prodData && prodData.length > 0) {
            localProductRow = prodData[0];
            dbProductId = prodData[0].id;
          }
        }
      } catch (err) {
        console.error("[VerifyAPI] Failed to fetch local product via REST:", err);
      }
    }

    // 4. Decide WHICH verification path this scan belongs on, then run it.
    // National Foods has no public barcode database (that's why the scraper
    // and the pgvector catalog exist), while the external databases carry
    // international SKUs but not National Foods ones — so the two categories
    // need different evidence, and a miss means something different on each.
    const brandContext = await resolveBrandContext({
      localCatalogBrand: localProductRow?.brand_name ?? null,
      barcode,
      imageBase64,
      mimeType,
    });

    const verificationPath: VerificationPath = brandContext.isNationalFoods
      ? "national_rag"
      : "external_db";

    console.log(
      `[VerifyAPI] path=${verificationPath} brand=${brandContext.detectedBrand ?? "unknown"} via=${brandContext.source}`
    );

    const pathInput = {
      imageUrl,
      imageBase64,
      mimeType,
      backImageBase64,
      backMimeType,
      barcode,
      localProduct: localProductRow ? mapLocalProductToUnified(localProductRow) : null,
      localProductId: dbProductId,
    };

    const outcome =
      verificationPath === "national_rag"
        ? await runNationalRagPath(pathInput)
        : await runExternalDbPath(pathInput);

    const { gemini } = outcome;
    const product = outcome.product;
    const apiSource = outcome.apiSource;
    const finalScore = outcome.score;
    const dbVerdict = outcome.dbVerdict;
    const displayVerdict = outcome.displayVerdict;
    dbProductId = outcome.dbProductId;

    // Status mirrors displayVerdict so the headline can never contradict the
    // verdict shown beside it.
    const status: "Likely Original" | "Needs Manual Review" | "Likely Counterfeit" =
      displayVerdict === "genuine"
        ? "Likely Original"
        : displayVerdict === "counterfeit"
          ? "Likely Counterfeit"
          : "Needs Manual Review";

    // Fixed-glossary verdict phrase, looked up synchronously — no API call.
    const verdictPhrase = getVerdictTextSync(dbVerdict);

    // Use the device's real GPS coordinates only — never fabricate a location.
    const rawLat = formData.get("latitude") as string | null;
    const rawLng = formData.get("longitude") as string | null;
    const scanLat = rawLat ? parseFloat(rawLat) : null;
    const scanLng = rawLng ? parseFloat(rawLng) : null;
    let scanArea = formData.get("area_name") as string | null;
    if (!scanArea) {
      scanArea = scanLat != null && scanLng != null
        ? await reverseGeocode(scanLat, scanLng)
        : "Location unavailable";
    }

    let scanId = "scan-" + Date.now();
    if (supabaseUrl && anonKey) {
      try {
        const scanRes = await fetch(`${supabaseUrl}/rest/v1/Scan`, {
          method: "POST",
          headers: {
            "apikey": anonKey,
            "Authorization": `Bearer ${anonKey}`,
            "Content-Type": "application/json",
            "Prefer": "return=representation"
          },
          body: JSON.stringify({
            product_id: dbProductId,
            // `product` already incorporates local catalog / scraper-match
            // data (see the identification block above), so this alone
            // covers all three source paths, not just external DB lookups.
            product_name: product?.name || null,
            brand_name: product?.brand || null,
            category: product?.category || null,
            barcode: barcode?.trim() || product?.barcode || null,
            scanned_by_role: (formData.get("role") as any) || "consumer",
            image_url: imageUrl,
            extracted_batch: gemini.tampering ? "Tampered" : "Standard Batch",
            extracted_mfg_date: new Date().toLocaleDateString(),
            extracted_mrp: null,
            // Per-check Gemini signals, kept so the dashboard can render real
            // "AI Flags Detected" for this specific scan instead of static text.
            ocr_raw_json: {
              logoMatch: gemini.logoMatch,
              packagingMatch: gemini.packagingMatch,
              barcodeMatch: gemini.barcodeMatch,
              brandMatch: gemini.brandMatch,
              designMatch: gemini.designMatch,
              tampering: gemini.tampering,
              reason: gemini.reason,
            },
            cv_anomaly_score: (100 - gemini.packagingMatch) / 100,
            verdict: dbVerdict,
            confidence: finalScore / 100,
            latitude: scanLat,
            longitude: scanLng,
            area_name: scanArea,
            customer_id: customerId,
          })
        });
        if (scanRes.ok) {
          const scanData = await scanRes.json();
          if (scanData && scanData.length > 0) {
            scanId = scanData[0].id;
          }
        } else {
          const errText = await scanRes.text();
          console.error("[VerifyAPI] Scan REST creation failed:", scanRes.status, errText);
        }
      } catch (dbErr) {
        console.error("[VerifyAPI] Failed to write scan record to DB via REST:", dbErr);
      }
    }

    // Award scorecard points for catching a suspicious/counterfeit scan
    if (dbVerdict === "suspicious" && customerId) {
      await incrementCustomerScore(customerId, 10);
    }

    // Return structured payload
    const responsePayload = {
      scan_id: scanId,
      status,
      score: finalScore,
      product: product ? {
        name: product.name,
        brand: product.brand,
        manufacturer: product.manufacturer,
        category: product.category,
        barcode: product.barcode,
        size: product.size,
        referenceImage: product.referenceImage,
      } : {
        name: "Unregistered Product",
        brand: "Unknown",
        manufacturer: "Unknown",
        category: "Unknown",
        barcode: barcode || "None Detected",
        size: "Unknown",
        referenceImage: "",
      },
      gemini: {
        logoMatch: gemini.logoMatch,
        packagingMatch: gemini.packagingMatch,
        barcodeMatch: gemini.barcodeMatch,
        brandMatch: gemini.brandMatch,
        designMatch: gemini.designMatch,
        tampering: gemini.tampering,
        confidence: gemini.confidence,
        reason: gemini.reason,
      },
      apiSource,
      // The reason now comes from the path that actually decided the verdict —
      // for a National Foods catalogue miss that's the explicit "not in the
      // reference catalogue" finding, not a generic Gemini remark.
      reason: outcome.reasonEn,
      // Bilingual output. The verdict phrase comes from the fixed glossary and
      // is never free-translated (see src/lib/translate.ts); only the reason
      // sentence is model-generated, and it comes from the same Gemini call
      // that produced the English one, so this costs no extra latency.
      reason_en: outcome.reasonEn,
      reason_ur: outcome.reasonUr,
      urdu_text: verdictPhrase.urdu_text,
      english_text: verdictPhrase.english_text,
      barcodeDetected: !!barcode,

      // ── Routing transparency ────────────────────────────────────────────
      verificationPath,
      brandContext,
      vectorSimilarity: outcome.vectorSimilarity,
      // Display-only superset of the DB verdict: `counterfeit` is rendered by
      // VerdictBadge but is NOT a Prisma Verdict value, so the row above
      // stored `suspicious`. Result screens read this field.
      displayVerdict,
    };

    return NextResponse.json(responsePayload, { status: 200 });
  } catch (err) {
    console.error("[VerifyAPI] Unhandled error:", err);
    try {
      const fs = require('fs');
      const path = require('path');
      const logPath = 'c:/Users/Sonu computers/Desktop/kxbl/verify_debug.log';
      const logMsg = `[${new Date().toISOString()}] Error: ${err instanceof Error ? err.stack : String(err)}\n\n`;
      fs.appendFileSync(logPath, logMsg);
    } catch (logErr) {
      console.error("Failed to write to verify_debug.log:", logErr);
    }
    return NextResponse.json(
      { error: `Internal server error during verification processing: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
