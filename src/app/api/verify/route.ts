/**
 * POST /api/verify
 *
 * Real product authenticity verification endpoint.
 * Runs barcode scanner (Gemini fallback), queries external DB APIs (UPCItemDB, Open Food Facts, Barcode Lookup),
 * performs side-by-side Gemini visual comparison, calculates authenticity score, and returns structured data.
 */

import { NextRequest, NextResponse } from "next/server";
import type { ScannedByRole } from "@/lib/supabaseTypes";

/* REMOVED: process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0".
 *
 * That line disabled TLS certificate verification for the entire Node process,
 * not just this route — every outbound HTTPS call (Supabase, Gemini, the
 * external barcode APIs) silently accepted any certificate, which is a
 * man-in-the-middle risk in production.
 *
 * Its stated purpose was self-signed certs on a direct Postgres connection,
 * but this route reaches the database over Supabase's REST API on a publicly
 * trusted certificate, so nothing here needed it. If a local self-signed cert
 * ever does need trusting, scope it to that one connection (or set
 * NODE_EXTRA_CA_CERTS locally) rather than disabling verification globally.
 */

/** Narrow untrusted form input to the enum the column accepts. */
function parseScannedByRole(value: FormDataEntryValue | null): ScannedByRole {
  return value === "shopkeeper" ? "shopkeeper" : "consumer";
}

import { scanBarcodeFromImage, manualBarcodeRead, type BarcodeRead } from "@/services/barcodeScanner";
import { UnifiedProduct } from "@/services/cacheService";
import { uploadImage } from "@/lib/blob";
import { getCustomerIdFromRequest, incrementCustomerScore } from "@/lib/customer";
import { getVerdictTextSync } from "@/lib/translate";
import { resolveBrandContext, isMedicineScan, textLooksLikeMedicine } from "@/services/brandRouter";
import { readPackagingText } from "@/lib/ocr";
import { isMedicineGs1 } from "@/services/gs1Parser";
import { customerReporterKey } from "@/services/medicineChecks";
import {
  runNationalRagPath,
  runExternalDbPath,
  runMedicinePath,
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
    const typedBarcode = formData.get("barcode") as string | null;

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
    // Each photo goes ZXing decode -> Gemini digit read (barcodeScanner.ts).
    let barcodeRead: BarcodeRead | null =
      typedBarcode && typedBarcode.trim() !== "" ? manualBarcodeRead(typedBarcode) : null;
    if (!barcodeRead) {
      console.log("[VerifyAPI] No barcode provided in request. Running visual scanner...");
      barcodeRead = await scanBarcodeFromImage(imageBase64, mimeType);
      console.log(`[VerifyAPI] Visual scanner result (front): ${barcodeRead?.value ?? null} via ${barcodeRead?.source ?? "-"}`);

      if (!barcodeRead && backImageBase64 && backMimeType) {
        barcodeRead = await scanBarcodeFromImage(backImageBase64, backMimeType);
        console.log(`[VerifyAPI] Visual scanner result (back): ${barcodeRead?.value ?? null} via ${barcodeRead?.source ?? "-"}`);
      }
    }
    // Only a product code is looked up — a QR code holding a plain URL still
    // counts as "barcode detected" but has no SKU to match.
    const barcode = barcodeRead?.productCode ?? null;

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
    let localProductRow: { id: string; product_name: string; brand_name: string; sku: string; pack_size?: string | null; reference_image_url?: string | null; category?: string | null } | null = null;
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
      barcodeSource: barcodeRead?.source ?? null,
      imageBase64,
      mimeType,
      backImageBase64,
      backMimeType,
    });

    // Medicines get their own path; food/FMCG routing below is unchanged.
    const gs1Medicine = !!barcodeRead?.gs1 && isMedicineGs1(barcodeRead.gs1);
    // Fallback when Gemini's classification didn't answer (it times out when
    // Gemini is slow): read the pack's text — front and back — and look for
    // medicine cues. Only runs when nothing stronger has decided the route.
    const packagingText =
      brandContext.category === null && !gs1Medicine && !localProductRow && !brandContext.isNationalFoods
        ? await readPackagingText([
            { data: imageBase64, mimeType },
            { data: backImageBase64, mimeType: backMimeType },
          ])
        : null;
    const isMedicine = isMedicineScan({
      gs1Medicine,
      catalogMedicine: localProductRow?.category === "medicine",
      catalogNonMedicine: !!localProductRow && localProductRow.category !== "medicine",
      packagingMedicine: brandContext.category === "medicine" || textLooksLikeMedicine(packagingText),
      nationalFoods: brandContext.isNationalFoods,
    });

    const verificationPath: VerificationPath = isMedicine
      ? "medicine"
      : brandContext.isNationalFoods
        ? "national_rag"
        : "external_db";

    console.log(
      `[VerifyAPI] path=${verificationPath} brand=${brandContext.detectedBrand ?? "unknown"} via=${brandContext.source} category=${brandContext.category ?? "-"}` +
        (packagingText !== null ? ` text-fallback=${textLooksLikeMedicine(packagingText) ? "medicine" : "no cues"}` : "")
    );

    // Use the device's real GPS coordinates only — never fabricate a location.
    // Resolved before the path runs: the medicine duplicate-serial check
    // counts distinct areas.
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

    const pathInput = {
      imageUrl,
      imageBase64,
      mimeType,
      backImageBase64,
      backMimeType,
      barcode,
      localProduct: localProductRow ? mapLocalProductToUnified(localProductRow) : null,
      localProductId: dbProductId,
      wordmarkStatus: brandContext.wordmarkStatus,
      detectedBrand: brandContext.detectedBrand,
      imitatedBrand: brandContext.imitatedBrand,
      barcodeRead,
      packagingBrand: brandContext.packagingBrand,
      reporterKey: customerReporterKey(customerId),
      area: scanArea,
    };

    const outcome =
      verificationPath === "medicine"
        ? await runMedicinePath(pathInput)
        : verificationPath === "national_rag"
          ? await runNationalRagPath(pathInput)
          : await runExternalDbPath(pathInput);

    const { gemini } = outcome;
    const medicine = outcome.medicine ?? null;
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
    // Medicines use their own fixed phrases: the food glossary's "genuine"
    // line says "verified as authentic", which a medicine must never show.
    const verdictPhrase = medicine?.verdict
      ? { urdu_text: medicine.verdict.phrase.ur, english_text: medicine.verdict.phrase.en }
      : getVerdictTextSync(dbVerdict);

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
            product_name: product?.name || medicine?.printed?.brandName || null,
            brand_name: product?.brand || null,
            category: isMedicine ? "Medicine" : product?.category || null,
            barcode: barcode?.trim() || product?.barcode || null,
            // Validated against the enum rather than blind-cast: a client
            // sending role=admin would otherwise be written straight into the
            // column and rejected by Postgres (or worse, accepted).
            scanned_by_role: parseScannedByRole(formData.get("role")),
            image_url: imageUrl,
            // Medicines record the real batch (DataMatrix, else as printed);
            // food rows keep their existing value.
            extracted_batch: medicine
              ? medicine.gs1?.batch ?? medicine.printed?.batch ?? null
              : gemini.tampering ? "Tampered" : "Standard Batch",
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
              // Barcode provenance lives here rather than in new columns.
              barcodeSource: outcome.barcodeCheck.source,
              barcodeFormat: outcome.barcodeCheck.format,
              barcodeCheck: outcome.barcodeCheck.status,
              // What the wordmark call classified the pack as.
              category: brandContext.category,
              ...(medicine ? { medicineChecks: medicine.checks, medicinePrinted: medicine.printed } : {}),
            },
            // GS1 / printed medicine codes (null for food).
            gtin: medicine?.gs1?.gtin ?? null,
            serial: medicine?.gs1?.serial ?? null,
            expiry_date: medicine?.expiry.date ?? null,
            drap_reg_no: medicine?.printed?.drapRegNo ?? null,
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

    // Award scorecard points on every completed scan, not just suspicious
    // ones. Points now redeem for HORECA dining vouchers (/rewards), and when
    // only suspicious scans earned, a consumer scanning genuine product --
    // which is most scans -- never accumulated anything and never reached a
    // reward. Suspicious still pays the most: catching a counterfeit is the
    // behaviour worth paying for.
    const POINTS_BY_VERDICT: Record<string, number> = {
      genuine: 5,
      suspicious: 15,
      unverified: 2,
    };
    if (customerId) {
      const points = POINTS_BY_VERDICT[dbVerdict] ?? 0;
      if (points > 0) await incrementCustomerScore(customerId, points);
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
      barcodeDetected: !!barcodeRead,
      // One bilingual line shown beside the reason — status, source and format
      // so a decoded barcode can be told apart from an AI-read one.
      barcodeCheck: outcome.barcodeCheck,
      // Medicine scans only: printed fields, GS1 data and per-check results.
      // Not rendered yet — the result pages pick it up in phase 4.
      medicine,

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
    // The file-logging block that used to sit here appended to
    // 'c:/Users/Sonu computers/Desktop/kxbl/verify_debug.log' — an absolute path
    // on one developer's machine. It could never resolve anywhere else, and on
    // Vercel the filesystem is read-only, so it only ever threw into its own
    // catch. console.error is already captured by the platform's log drain.
    console.error("[VerifyAPI] Unhandled error:", err instanceof Error ? err.stack : err);
    return NextResponse.json(
      { error: `Internal server error during verification processing: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
