/**
 * lib/verifyProduct.ts
 *
 * The core shared verification pipeline.
 * Called by both /api/scan and /api/whatsapp-webhook.
 * Do NOT duplicate this logic in the route handlers.
 *
 * Pipeline:
 *  1. Upload image to Vercel Blob → public URL
 *  2. Race OCR + CV + vector image search (RAG match) with a timeout guard,
 *     alongside a barcode read from the photo (ZXing decode -> Gemini read)
 *  3. Lookup product by barcode/SKU → vector image match → batch pattern
 *  4. Rule-based verdict (genuine | suspicious | unverified)
 *  5. Translate verdict — Gemini image comparison when identified via RAG match
 *  6. Write Scan row to DB
 *  7. If suspicious → write Report row
 *  8. Return full verdict payload
 */

import { uploadImage } from "./blob";
import { runOcr, readPackagingText } from "./ocr";
import { scorePackaging } from "./cv";
import { getVerdictText, getVerdictTextSync, compareProductImages } from "./translate";
import { findProductByImage, type VectorMatch } from "./vectorSearch";
import { comparePixelWise, GENUINE_THRESHOLD, type PixelCompareResult } from "./pixelCompare";
import { incrementCustomerScore } from "./customer";
import { scanBarcodeFromImage, manualBarcodeRead, type BarcodeRead } from "@/services/barcodeScanner";
import { assessBarcode, barcodeMismatchReason, type BarcodeCheck } from "@/services/barcodeEvidence";
import { prefixOwner, isMedicineScan, textLooksLikeMedicine } from "@/services/brandRouter";
import { isMedicineGs1 } from "@/services/gs1Parser";
import { compareImagesWithGemini } from "@/services/geminiVision";
import { assessMedicine, customerReporterKey, type MedicineAssessment } from "@/services/medicineChecks";
import { identifyByCodeOrImage, catalogMedicineToUnified } from "@/services/medicineCatalog";
import { decideMedicineVerdict, packagingCheck, sortChecks } from "@/services/medicineVerdict";
import type { Verdict, ScannedByRole } from "@prisma/client";

// ─── Thresholds ───────────────────────────────────────────────────────────────

/**
 * Brands verified by strict structural comparison against our own catalogue
 * photography (lib/pixelCompare.ts) instead of the generic CV anomaly score.
 * Only add a brand here once we actually hold clean reference images for it —
 * without one, every scan falls back to the standard path anyway.
 */
const PIXEL_COMPARE_BRANDS = new Set(["National Foods"]);

/**
 * If cv_anomaly_score >= SUSPICIOUS_THRESHOLD → suspicious verdict
 * (assuming product match exists; otherwise → unverified)
 */
const SUSPICIOUS_THRESHOLD = 0.55;

/** External API timeout in ms before falling back to rule-only verdict */
const API_TIMEOUT_MS = 5000;

/** Vector search (embedding + RPC) timeout — slightly longer than OCR/CV since it's two network hops */
const VECTOR_TIMEOUT_MS = 7000;

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
    console.error("[verifyProduct] Reverse geocoding error:", err);
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

export interface VerifyInput {
  imageFile: File | Blob;   // The raw image upload
  barcode?: string | null;  // Optional barcode/SKU from client
  latitude?: number | null;
  longitude?: number | null;
  area_name?: string | null;
  scanned_by_role?: ScannedByRole;
  /** Logged-in customer id (from the customer_session cookie), if any. */
  customer_id?: string | null;
  /** Opaque reporter key for the duplicate-serial check — phoneReporterKey()
   *  for WhatsApp. Defaults to the customer id. Never a raw phone number. */
  reporter_key?: string | null;
}

export interface VerifyResult {
  scan_id: string;
  verdict: Verdict;
  confidence: number;
  reason: string;
  /** Urdu counterpart of `reason`. `reason` stays the English text so
   *  existing consumers of this shape are unaffected. */
  reason_ur: string;
  urdu_text: string;
  english_text: string;
  image_url: string;
  extracted_batch: string | null;
  extracted_mfg_date: string | null;
  extracted_mrp: string | null;
  cv_anomaly_score: number | null;
  product_name: string | null;
  brand_name: string | null;
  /** RAG-style image identification result — see lib/vectorSearch.ts */
  image_match: {
    matched: boolean;
    similarity: number | null;
    note?: string;
  };
  /** One-line barcode result shown beside the reason — see services/barcodeEvidence.ts. */
  barcode_check: BarcodeCheck;
  /** Medicine scans only: printed fields, GS1 data and per-check results. */
  medicine?: MedicineAssessment | null;
}

// ─── Timeout helper ───────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ─── Product lookup ───────────────────────────────────────────────────────────

/**
 * Open Food Facts is a community-maintained, mostly food/grocery-focused database,
 * so coverage for non-food FMCG items (soaps, detergents, cosmetics) may be limited.
 * It should be treated as a "nice to have" enrichment source, not the primary source of truth.
 */
async function fetchOpenFoodFacts(barcode: string): Promise<{ product_name: string | null; brand_name: string | null } | null> {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500); // 3.5 seconds timeout

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "ShelfWatch - FMCG Authenticity Verification Pipeline - Version 1.0",
      },
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.status === 1 && data.product) {
      return {
        product_name: data.product.product_name || data.product.product_name_en || null,
        brand_name: data.product.brands || null,
      };
    }
  } catch (err) {
    console.warn("[Open Food Facts API Lookup] Failed or timed out:", err);
  }
  return null;
}

/**
 * UPCitemdb is queried using the free trial plan, which does not require an API key
 * but has a rate limit of 100 requests/day per IP.
 */
async function fetchUPCItemDB(barcode: string): Promise<{ product_name: string | null; brand_name: string | null } | null> {
  const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500); // 3.5 seconds timeout

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
      },
    });
    clearTimeout(timeoutId);

    if (res.status === 429) {
      console.warn("[UPCitemdb API Lookup] Rate limit reached (100 requests/day/IP exceeded).");
      return null;
    }

    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.code === "OK" && data.total > 0 && data.items && data.items.length > 0) {
      const item = data.items[0];
      return {
        product_name: item.title || null,
        brand_name: item.brand || null,
      };
    }
  } catch (err) {
    console.warn("[UPCitemdb API Lookup] Failed or timed out:", err);
  }
  return null;
}

/** Exact SKU match (barcode scan) — the strongest identity signal, tried first. */
async function findProductByBarcode(barcode: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return null;

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/Product?sku=eq.${encodeURIComponent(barcode.trim())}`, {
      headers: { "apikey": anonKey, "Authorization": `Bearer ${anonKey}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) return data[0];
    }
  } catch (err) {
    console.error("[verifyProduct] findProductByBarcode fetch failed:", err);
  }
  return null;
}

/**
 * Batch pattern match — iterate and test regex against extracted batch.
 * Lower-precedence than an exact barcode or vector image match: a loose
 * regex scan across every product is a weaker identity signal than either.
 */
async function findProductByBatchPattern(batch: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return null;

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/Product?select=id,sku,brand_name,product_name,reference_batch_pattern,avg_unit_price_pkr`, {
      headers: { "apikey": anonKey, "Authorization": `Bearer ${anonKey}` }
    });
    if (res.ok) {
      const products = await res.json();
      for (const p of products) {
        try {
          const re = new RegExp(p.reference_batch_pattern, "i");
          if (re.test(batch)) return p;
        } catch {
          // invalid regex in DB — skip
        }
      }
    }
  } catch (err) {
    console.error("[verifyProduct] findProductByBatchPattern fetch failed:", err);
  }
  return null;
}

// ─── Verdict logic ────────────────────────────────────────────────────────────

function computeVerdict(
  product: { reference_batch_pattern: string } | null,
  batch: string | null,
  anomalyScore: number,
  imageIdentified?: { similarity: number }
): { verdict: Verdict; confidence: number } {
  if (!product) {
    // No product match → unverified regardless of CV score
    return { verdict: "unverified", confidence: 0.4 };
  }

  // Product was identified via vector image match rather than an exact
  // barcode/batch record — scraped catalogs (e.g. National Foods) have no
  // real reference_batch_pattern, so requiring a batch match here would
  // wrongly flag genuine image-identified scans as suspicious. Use CV
  // anomaly score + match similarity as the genuineness signal instead.
  if (imageIdentified) {
    if (anomalyScore < SUSPICIOUS_THRESHOLD) {
      const confidence = (1 - anomalyScore) * imageIdentified.similarity;
      return { verdict: "genuine", confidence: Math.min(confidence, 0.99) };
    }
    return { verdict: "suspicious", confidence: Math.min(anomalyScore, 0.99) };
  }

  const batchMatches = batch
    ? (() => {
        try {
          return new RegExp(product.reference_batch_pattern, "i").test(batch);
        } catch {
          return false;
        }
      })()
    : false;

  if (anomalyScore < SUSPICIOUS_THRESHOLD && batchMatches) {
    // Low anomaly + batch match → genuine
    const confidence = (1 - anomalyScore) * (batchMatches ? 1 : 0.8);
    return { verdict: "genuine", confidence: Math.min(confidence, 0.99) };
  }

  // High anomaly or batch mismatch → suspicious
  const confidence = anomalyScore;
  return { verdict: "suspicious", confidence: Math.min(confidence, 0.99) };
}

/**
 * Reason text for a strict-comparison verdict, written directly in both
 * languages rather than round-tripped through Gemini: the numbers are the
 * whole point of the message, and a free translation is free to lose them.
 */
function pixelCompareReason(
  result: PixelCompareResult,
  productName: string | null,
  brandName: string | null
): { en: string; ur: string } {
  const pct = Math.round(result.score * 100);
  const thresholdPct = Math.round(GENUINE_THRESHOLD * 100);
  const label = [brandName, productName].filter(Boolean).join(" ") || "this product";
  const labelUr = [brandName, productName].filter(Boolean).join(" ") || "اس مصنوع";

  if (result.suspicious) {
    return {
      en:
        `Structural comparison against the genuine ${label} reference photo scored ` +
        `${pct}% similarity, below the ${thresholdPct}% authenticity threshold. ` +
        `Logo placement, typography or colour differ from the manufacturer's ` +
        `catalogue image — this appears to be a counterfeit or unauthorised copy.`,
      ur:
        `اصل ${labelUr} کی حوالہ جاتی تصویر سے ساختی موازنہ ${pct}% مشابہت پر رہا، ` +
        `جو ${thresholdPct}% کی تصدیقی حد سے کم ہے۔ لوگو کی جگہ، تحریر یا رنگ ` +
        `کارخانہ دار کی تصویر سے مختلف ہیں — یہ نقلی یا غیر مجاز نقل معلوم ہوتی ہے۔`,
    };
  }

  return {
    en:
      `Matches the genuine ${label} reference photo at ${pct}% structural and ` +
      `colour similarity, above the ${thresholdPct}% authenticity threshold.`,
    ur:
      `اصل ${labelUr} کی حوالہ جاتی تصویر سے ${pct}% ساختی اور رنگی مشابہت پر ` +
      `مطابقت رکھتا ہے، جو ${thresholdPct}% کی تصدیقی حد سے زیادہ ہے۔`,
  };
}

// ─── Public pipeline function ────────────────────────────────────────────────

/**
 * Run the full ShelfWatch verification pipeline.
 * This is the single source of truth for scan logic.
 */
export async function verifyProduct(input: VerifyInput): Promise<VerifyResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // ── Step 1: Upload image to Vercel Blob ──────────────────────────────────
  const filename = `scan-${Date.now()}.jpg`;
  let imageUrl: string;

  try {
    imageUrl = await uploadImage(filename, input.imageFile);
  } catch (err) {
    console.error("[verifyProduct] Blob upload failed:", err);
    // Use a placeholder URL so the scan row still gets written
    imageUrl = `https://placeholder.shelfwatch.pk/scan/${filename}`;
  }

  // ── Step 2: Race OCR + CV + vector image search with timeout ─────────────
  let ocrBatch: string | null = null;
  let ocrMfgDate: string | null = null;
  let ocrMrp: string | null = null;
  let ocrRaw: Record<string, unknown> = {};
  let cvScore: number | null = null;
  let vectorMatch: VectorMatch | null = null;

  // Barcode read (ZXing decode -> Gemini digit read) alongside the rest.
  // WhatsApp sends only a photo, so before this the barcode check was skipped
  // entirely for every WhatsApp scan. A barcode passed in is used as typed.
  const barcodeReadPromise: Promise<BarcodeRead | null> = input.barcode
    ? Promise.resolve(manualBarcodeRead(input.barcode))
    : input.imageFile
        .arrayBuffer()
        .then((buf) => scanBarcodeFromImage(Buffer.from(buf).toString("base64"), input.imageFile.type || "image/jpeg"))
        .catch((err) => {
          console.warn("[verifyProduct] Barcode read failed:", err);
          return null;
        });

  const [ocrSettled, cvSettled, vectorSettled] = await Promise.allSettled([
    withTimeout(runOcr(imageUrl), API_TIMEOUT_MS),
    withTimeout(scorePackaging(imageUrl), API_TIMEOUT_MS),
    withTimeout(findProductByImage(imageUrl), VECTOR_TIMEOUT_MS),
  ]);

  if (ocrSettled.status === "fulfilled") {
    ocrBatch = ocrSettled.value.batch;
    ocrMfgDate = ocrSettled.value.mfg_date;
    ocrMrp = ocrSettled.value.mrp;
    ocrRaw = ocrSettled.value.raw;
  } else {
    console.warn("[verifyProduct] OCR timed out or failed:", ocrSettled.reason);
  }

  if (cvSettled.status === "fulfilled") {
    cvScore = cvSettled.value.anomaly_score;
  } else {
    console.warn("[verifyProduct] CV timed out or failed:", cvSettled.reason);
    cvScore = 0.5; // neutral fallback
  }

  if (vectorSettled.status === "fulfilled") {
    vectorMatch = vectorSettled.value; // null if no embedding/no match above threshold — handled gracefully below
  } else {
    console.warn("[verifyProduct] Vector image search timed out or failed:", vectorSettled.reason);
  }

  // ── Step 3: Product lookup ────────────────────────────────────────────────
  // Precedence: exact barcode/SKU (strongest) → vector image match → batch
  // pattern regex scan → external OFF/UPCitemdb metadata (barcode-only).
  const barcodeRead = await barcodeReadPromise;
  // Only a product code is looked up — a QR code holding a URL has no SKU.
  const barcode = barcodeRead?.productCode ?? null;

  let product: VectorMatch["product"] | null = null;
  let identifiedViaImage = false;

  if (barcode) {
    product = await findProductByBarcode(barcode);
  }
  const identifiedViaBarcode = !!product;

  if (!product && vectorMatch) {
    product = vectorMatch.product;
    identifiedViaImage = true;
  }

  if (!product && ocrBatch) {
    product = await findProductByBatchPattern(ocrBatch);
  }

  // Fallback metadata lookup from Open Food Facts / UPCitemdb if local DB has no record
  let offProduct: { product_name: string | null; brand_name: string | null } | null = null;
  if (!product && barcode) {
    offProduct = await fetchOpenFoodFacts(barcode);
    if (!offProduct) {
      offProduct = await fetchUPCItemDB(barcode);
    }
  }

  // ── Barcode evidence ──────────────────────────────────────────────────────
  // Which company a DECODED barcode belongs to, compared with what the image
  // match says the pack is. Only a decoded barcode can raise a mismatch (see
  // services/barcodeEvidence.ts), so the extra lookups run only for one.
  let barcodeBrand: string | null = null;
  if (barcode && barcodeRead?.source === "decoded") {
    barcodeBrand =
      (identifiedViaBarcode ? product?.brand_name : null) ??
      (await prefixOwner(barcode)) ??
      offProduct?.brand_name ??
      (product
        ? (
            await withTimeout(
              fetchOpenFoodFacts(barcode).then((r) => r ?? fetchUPCItemDB(barcode)),
              API_TIMEOUT_MS
            ).catch(() => null)
          )?.brand_name ?? null
        : null);
  }
  const packagingBrand = vectorMatch?.product.brand_name ?? null;
  // The barcode only "verifies" the product when the image doesn't point at a
  // different catalogue product.
  const barcodeMatchesProduct =
    (identifiedViaBarcode && (!vectorMatch || vectorMatch.product.id === product?.id)) ||
    (!product && !!offProduct);
  const barcodeCheck = assessBarcode({
    read: barcodeRead,
    matched: barcodeMatchesProduct,
    barcodeBrand,
    packagingBrand,
    // This pipeline has no Gemini tampering flag to draw on.
    tampering: false,
  });

  // A barcode read from the photo that lands on the SAME catalogue product the
  // image match found: judge it on the existing image-identified branch rather
  // than the barcode branch, whose OCR batch-pattern requirement a scraped
  // catalogue row can't meet. A typed barcode keeps its previous behaviour.
  const imageCorroboration =
    vectorMatch &&
    (identifiedViaImage ||
      (identifiedViaBarcode && barcodeRead?.source !== "manual" && vectorMatch.product.id === product?.id))
      ? { similarity: vectorMatch.similarity }
      : undefined;

  const imageMatch = {
    matched: identifiedViaImage,
    similarity: vectorMatch?.similarity ?? null,
    ...(identifiedViaImage ? {} : { note: "Unrecognized product / low confidence" }),
  };

  // ── Medicine routing ──────────────────────────────────────────────────────
  // Same decision as /api/verify (isMedicineScan). This pipeline has no
  // wordmark call, so the packaging signal comes from text on the pack — no
  // extra AI request. runOcr above reads nothing today (see readPackagingText
  // in lib/ocr.ts), so when its text has no cues and nothing stronger decided
  // the route, the packaging text is read for medicine detection only.
  const catalogCategory = (product as { category?: string | null } | null)?.category ?? null;
  const gs1Medicine = !!barcodeRead?.gs1 && isMedicineGs1(barcodeRead.gs1);
  const catalogNonMedicine = (identifiedViaBarcode || identifiedViaImage) && catalogCategory !== "medicine";
  const ocrText = typeof ocrRaw.fullText === "string" ? ocrRaw.fullText : null;
  let packagingMedicine = textLooksLikeMedicine(ocrText);
  if (!packagingMedicine && !gs1Medicine && !catalogNonMedicine && catalogCategory !== "medicine") {
    const packagingText = await readPackagingText([
      { data: Buffer.from(await input.imageFile.arrayBuffer()).toString("base64"), mimeType: input.imageFile.type || "image/jpeg" },
    ]);
    packagingMedicine = textLooksLikeMedicine(packagingText);
  }
  const isMedicine = isMedicineScan({
    gs1Medicine,
    catalogMedicine: catalogCategory === "medicine",
    catalogNonMedicine,
    packagingMedicine,
  });

  // Resolved before the verdict: the medicine duplicate-serial check counts
  // distinct areas.
  // Use the device's real GPS coordinates only — never fabricate a location.
  const scanLat = input.latitude ?? null;
  const scanLng = input.longitude ?? null;
  let scanArea = input.area_name;
  if (!scanArea) {
    scanArea = scanLat != null && scanLng != null
      ? await reverseGeocode(scanLat, scanLng)
      : "Location unavailable";
  }

  // ── Step 4: Verdict ───────────────────────────────────────────────────────
  // Brands in PIXEL_COMPARE_BRANDS are judged against their own catalogue
  // photo. Every other brand — including anything identified only via Open
  // Food Facts / UPCitemdb — keeps the original computeVerdict path untouched.
  const brandForPixelCheck = product?.brand_name ?? offProduct?.brand_name ?? null;

  let verdict: Verdict;
  let confidence: number;
  /** Non-null only when a strict comparison actually produced a usable score. */
  let pixelResult: PixelCompareResult | null = null;

  let medicine: MedicineAssessment | null = null;
  if (isMedicine) {
    // The same packaging call /api/verify makes, transcribing the printed
    // medicine fields, then the shared medicine checks and verdict
    // (services/medicineVerdict.ts). A medicine is never judged by the food
    // rules, and its positive outcome is "no problems found", not genuine.
    const imageBase64 = Buffer.from(await input.imageFile.arrayBuffer()).toString("base64");
    const productCode = barcodeRead?.gs1?.gtin ?? barcodeRead?.productCode ?? null;
    const identity = await identifyByCodeOrImage(productCode, imageUrl);
    const gemini = await compareImagesWithGemini(
      imageBase64,
      catalogMedicineToUnified(identity.product),
      input.imageFile.type || "image/jpeg",
      undefined,
      barcodeRead?.source === "decoded" ? barcodeRead.productCode : null,
      { medicine: true }
    );
    medicine = await assessMedicine({
      gs1: barcodeRead?.gs1 ?? null,
      productCode: barcodeRead?.productCode ?? null,
      identity,
      printed: gemini.printed ?? null,
      reporterKey: input.reporter_key ?? customerReporterKey(input.customer_id),
      area: scanArea,
    });
    medicine.checks = sortChecks([
      ...medicine.checks,
      packagingCheck(gemini, !!identity.product?.reference_image_url),
    ]);
    medicine.verdict = decideMedicineVerdict(medicine);
    verdict = medicine.verdict.dbVerdict;
    confidence = medicine.verdict.score / 100;
  } else if (product && brandForPixelCheck && PIXEL_COMPARE_BRANDS.has(brandForPixelCheck)) {
    const result = await comparePixelWise(imageUrl, product.reference_image_url);

    if (result.error) {
      // No reference photo, or the comparison failed. Fall back rather than
      // defaulting to "genuine" — an unavailable check is not a passed check.
      console.warn(`[verifyProduct] Pixel compare unavailable (${result.error}) — falling back`);
      ({ verdict, confidence } = computeVerdict(
        product,
        ocrBatch,
        cvScore ?? 0.5,
        imageCorroboration
      ));
    } else {
      pixelResult = result;
      verdict = result.suspicious ? "suspicious" : "genuine";
      confidence = Math.min(result.score, 0.99);
    }
  } else {
    ({ verdict, confidence } = computeVerdict(
      product,
      ocrBatch,
      cvScore ?? 0.5,
      imageCorroboration
    ));
  }

  // A decoded barcode registered to a different company than the pack it's
  // printed on is a counterfeit signal — never genuine. "suspicious" is this
  // pipeline's strongest verdict; confidence stays as computed above.
  const barcodeMismatch = !isMedicine && barcodeCheck.status === "mismatch";
  if (barcodeMismatch) verdict = "suspicious";

  // ── Step 5: Translate verdict ─────────────────────────────────────────────
  // When the product was identified via image match and has a reference
  // image, ask Gemini to compare the two photos directly and use that as the
  // reason (richer, image-grounded) instead of the generic batch/score-based
  // reason — this also saves a second Gemini call.
  let verdictText: {
    urdu_text: string;
    english_text: string;
    reason: string;
    reason_ur: string;
  };
  if (medicine?.verdict) {
    // Medicine phrases, not the food glossary (whose genuine line reads
    // "verified as authentic").
    verdictText = {
      urdu_text: medicine.verdict.phrase.ur,
      english_text: medicine.verdict.phrase.en,
      reason: medicine.verdict.reasonEn,
      reason_ur: medicine.verdict.reasonUr,
    };
  } else if (barcodeMismatch && barcode && barcodeBrand && packagingBrand) {
    const packagingDefects =
      (cvScore ?? 0) >= SUSPICIOUS_THRESHOLD || !!pixelResult?.suspicious;
    const mismatchReason = barcodeMismatchReason(barcode, barcodeBrand, packagingBrand, packagingDefects);
    verdictText = {
      ...getVerdictTextSync(verdict),
      reason: mismatchReason.en,
      reason_ur: mismatchReason.ur,
    };
  } else if (pixelResult) {
    // Strict comparison already produced the numbers this verdict rests on —
    // report them rather than paying for a second, vaguer Gemini opinion.
    const pixelReason = pixelCompareReason(
      pixelResult,
      product?.product_name ?? null,
      product?.brand_name ?? null
    );
    verdictText = {
      ...getVerdictTextSync(verdict),
      reason: pixelReason.en,
      reason_ur: pixelReason.ur,
    };
  } else if (identifiedViaImage && product?.reference_image_url) {
    // compareProductImages now returns {en, ur} rather than a bare string.
    const comparisonReason = await compareProductImages(imageUrl, product.reference_image_url, {
      product_name: product.product_name,
      brand_name: product.brand_name,
    });
    verdictText = {
      ...getVerdictTextSync(verdict),
      reason: comparisonReason.en,
      reason_ur: comparisonReason.ur,
    };
  } else {
    verdictText = await getVerdictText(verdict, {
      batch: ocrBatch,
      anomaly_score: cvScore,
      brand_name: product?.brand_name ?? offProduct?.brand_name ?? undefined,
    });
  }

  // ── Step 6: Write Scan row ────────────────────────────────────────────────

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
          product_id: product?.id ?? null,
          product_name: product?.product_name ?? offProduct?.product_name ?? medicine?.printed?.brandName ?? null,
          brand_name: product?.brand_name ?? offProduct?.brand_name ?? null,
          barcode: barcode ?? null,
          ...(medicine
            ? {
                product_id: product?.id ?? medicine.identity.product?.id ?? null,
                category: "Medicine",
                gtin: medicine.gs1?.gtin ?? null,
                serial: medicine.gs1?.serial ?? null,
                expiry_date: medicine.expiry.date,
                drap_reg_no: medicine.printed?.drapRegNo ?? null,
              }
            : {}),
          scanned_by_role: input.scanned_by_role ?? "consumer",
          image_url: imageUrl,
          extracted_batch: medicine ? medicine.gs1?.batch ?? medicine.printed?.batch ?? ocrBatch : ocrBatch,
          extracted_mfg_date: ocrMfgDate,
          extracted_mrp: ocrMrp,
          // Barcode provenance rides along in the JSON rather than new columns.
          ocr_raw_json: {
            ...ocrRaw,
            barcode_check: { status: barcodeCheck.status, source: barcodeCheck.source, format: barcodeCheck.format },
            ...(medicine ? { medicine_checks: medicine.checks, medicine_printed: medicine.printed } : {}),
          },
          cv_anomaly_score: cvScore,
          verdict,
          confidence,
          latitude: scanLat,
          longitude: scanLng,
          area_name: scanArea,
          customer_id: input.customer_id ?? null,
        }),
      });

      if (scanRes.ok) {
        const scanData = await scanRes.json();
        if (scanData && scanData.length > 0) {
          scanId = scanData[0].id;
        }
      }
    } catch (err) {
      console.error("[verifyProduct] Failed to write scan to DB via REST:", err);
    }
  }

  // Award scorecard points for catching a suspicious/counterfeit scan
  if (verdict === "suspicious" && input.customer_id) {
    await incrementCustomerScore(input.customer_id, 10);
  }

  // ── Step 7: Write Report row if suspicious ────────────────────────────────
  if (verdict === "suspicious" && product && supabaseUrl && anonKey) {
    try {
      const brandRes = await fetch(`${supabaseUrl}/rest/v1/Brand?name=eq.${encodeURIComponent(product.brand_name)}`, {
        headers: { "apikey": anonKey, "Authorization": `Bearer ${anonKey}` }
      });
      if (brandRes.ok) {
        const brandData = await brandRes.json();
        if (brandData && brandData.length > 0) {
          const brand = brandData[0];
          await fetch(`${supabaseUrl}/rest/v1/Report`, {
            method: "POST",
            headers: {
              "apikey": anonKey,
              "Authorization": `Bearer ${anonKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              scan_id: scanId,
              brand_id: brand.id,
              status: "pending",
              notes: verdictText.reason,
            }),
          });
        }
      }
    } catch (err) {
      console.error("[verifyProduct] Failed to create report via REST:", err);
    }
  }

  return {
    scan_id: scanId,
    verdict,
    confidence,
    reason: verdictText.reason,
    reason_ur: verdictText.reason_ur,
    urdu_text: verdictText.urdu_text,
    english_text: verdictText.english_text,
    image_url: imageUrl,
    // Medicines report the same batch and name the Scan row stores.
    extracted_batch: medicine ? medicine.gs1?.batch ?? medicine.printed?.batch ?? ocrBatch : ocrBatch,
    extracted_mfg_date: ocrMfgDate,
    extracted_mrp: ocrMrp,
    cv_anomaly_score: cvScore,
    product_name: product?.product_name ?? offProduct?.product_name ?? medicine?.printed?.brandName ?? null,
    brand_name: product?.brand_name ?? offProduct?.brand_name ?? null,
    image_match: imageMatch,
    barcode_check: barcodeCheck,
    medicine,
  };
}
