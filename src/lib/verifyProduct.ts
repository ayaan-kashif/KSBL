/**
 * lib/verifyProduct.ts
 *
 * The core shared verification pipeline.
 * Called by both /api/scan and /api/whatsapp-webhook.
 * Do NOT duplicate this logic in the route handlers.
 *
 * Pipeline:
 *  1. Upload image to Vercel Blob → public URL
 *  2. Race OCR + CV + vector image search (RAG match) with a timeout guard
 *  3. Lookup product by barcode/SKU → vector image match → batch pattern
 *  4. Rule-based verdict (genuine | suspicious | unverified)
 *  5. Translate verdict — Gemini image comparison when identified via RAG match
 *  6. Write Scan row to DB
 *  7. If suspicious → write Report row
 *  8. Return full verdict payload
 */

import { uploadImage } from "./blob";
import { runOcr } from "./ocr";
import { scorePackaging } from "./cv";
import { getVerdictText, getVerdictTextSync, compareProductImages } from "./translate";
import { findProductByImage, type VectorMatch } from "./vectorSearch";
import { comparePixelWise, GENUINE_THRESHOLD, type PixelCompareResult } from "./pixelCompare";
import { incrementCustomerScore } from "./customer";
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
  let product: VectorMatch["product"] | null = null;
  let identifiedViaImage = false;

  if (input.barcode) {
    product = await findProductByBarcode(input.barcode);
  }

  if (!product && vectorMatch) {
    product = vectorMatch.product;
    identifiedViaImage = true;
  }

  if (!product && ocrBatch) {
    product = await findProductByBatchPattern(ocrBatch);
  }

  // Fallback metadata lookup from Open Food Facts / UPCitemdb if local DB has no record
  let offProduct: { product_name: string | null; brand_name: string | null } | null = null;
  if (!product && input.barcode) {
    offProduct = await fetchOpenFoodFacts(input.barcode);
    if (!offProduct) {
      offProduct = await fetchUPCItemDB(input.barcode);
    }
  }

  const imageMatch = {
    matched: identifiedViaImage,
    similarity: vectorMatch?.similarity ?? null,
    ...(identifiedViaImage ? {} : { note: "Unrecognized product / low confidence" }),
  };

  // ── Step 4: Verdict ───────────────────────────────────────────────────────
  // Brands in PIXEL_COMPARE_BRANDS are judged against their own catalogue
  // photo. Every other brand — including anything identified only via Open
  // Food Facts / UPCitemdb — keeps the original computeVerdict path untouched.
  const brandForPixelCheck = product?.brand_name ?? offProduct?.brand_name ?? null;

  let verdict: Verdict;
  let confidence: number;
  /** Non-null only when a strict comparison actually produced a usable score. */
  let pixelResult: PixelCompareResult | null = null;

  if (product && brandForPixelCheck && PIXEL_COMPARE_BRANDS.has(brandForPixelCheck)) {
    const result = await comparePixelWise(imageUrl, product.reference_image_url);

    if (result.error) {
      // No reference photo, or the comparison failed. Fall back rather than
      // defaulting to "genuine" — an unavailable check is not a passed check.
      console.warn(`[verifyProduct] Pixel compare unavailable (${result.error}) — falling back`);
      ({ verdict, confidence } = computeVerdict(
        product,
        ocrBatch,
        cvScore ?? 0.5,
        identifiedViaImage && vectorMatch ? { similarity: vectorMatch.similarity } : undefined
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
      identifiedViaImage && vectorMatch ? { similarity: vectorMatch.similarity } : undefined
    ));
  }

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
  if (pixelResult) {
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
  // Use the device's real GPS coordinates only — never fabricate a location.
  const scanLat = input.latitude ?? null;
  const scanLng = input.longitude ?? null;
  let scanArea = input.area_name;
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
          product_id: product?.id ?? null,
          product_name: product?.product_name ?? offProduct?.product_name ?? null,
          brand_name: product?.brand_name ?? offProduct?.brand_name ?? null,
          scanned_by_role: input.scanned_by_role ?? "consumer",
          image_url: imageUrl,
          extracted_batch: ocrBatch,
          extracted_mfg_date: ocrMfgDate,
          extracted_mrp: ocrMrp,
          ocr_raw_json: ocrRaw,
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
    extracted_batch: ocrBatch,
    extracted_mfg_date: ocrMfgDate,
    extracted_mrp: ocrMrp,
    cv_anomaly_score: cvScore,
    product_name: product?.product_name ?? offProduct?.product_name ?? null,
    brand_name: product?.brand_name ?? offProduct?.brand_name ?? null,
    image_match: imageMatch,
  };
}
