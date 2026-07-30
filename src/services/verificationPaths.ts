/**
 * services/verificationPaths.ts
 *
 * The two verification strategies /api/verify switches between. Routing lives
 * in brandRouter.ts; this module only executes whichever path was chosen.
 *
 *  Path A "national_rag"  — RAG against our own scraped catalog via CLIP
 *                           embeddings. External barcode DBs are skipped
 *                           entirely: they don't carry National Foods SKUs, so
 *                           a miss there is noise, not evidence.
 *  Path B "external_db"   — cache -> UPCItemDB -> Open Food Facts -> Barcode
 *                           Lookup, exactly as before. No vector search: the
 *                           catalog only holds National Foods rows, so a cosine
 *                           match for a non-National product is meaningless at
 *                           best and a false positive at worst.
 *
 * calculateAuthenticityScore and runComparisonEngine are used unchanged — only
 * which inputs reach them differs per path.
 */

import { lookupUPCItemDB } from "./upcItemDb";
import { lookupOpenFoodFacts } from "./openFoodFacts";
import { lookupBarcodeLookup } from "./barcodeLookup";
import { compareImagesWithGemini, type GeminiComparisonResult } from "./geminiVision";
import { runComparisonEngine } from "./comparisonEngine";
import { calculateAuthenticityScore } from "./scoreEngine";
import { getCachedProduct, setCachedProduct, type UnifiedProduct } from "./cacheService";
import { findProductByImage } from "@/lib/vectorSearch";
import { compareProductImages } from "@/lib/translate";
import { nationalCatalogEmbeddingCount } from "./brandRouter";

export type ApiSource =
  | "LocalCatalog"
  | "ScraperMatch"
  | "UPCItemDB"
  | "OpenFoodFacts"
  | "BarcodeLookup"
  | "none";

export type DbVerdict = "genuine" | "suspicious" | "unverified";
/** Superset of DbVerdict. `counterfeit` is display-only — the Prisma Verdict
 *  enum has no such value and adding one would mean a migration plus updating
 *  every dashboard/analytics/history/leaderboard filter. Store `suspicious`,
 *  show `counterfeit`. */
export type DisplayVerdict = DbVerdict | "counterfeit";
export type VerificationPath = "national_rag" | "external_db";

export interface PathOutcome {
  product: UnifiedProduct | null;
  apiSource: ApiSource;
  dbProductId: string | null;
  vectorSimilarity: number | null;
  dbVerdict: DbVerdict;
  displayVerdict: DisplayVerdict;
  score: number; // 0–100
  gemini: GeminiComparisonResult;
  reasonEn: string;
  reasonUr: string;
}

export interface PathInput {
  imageUrl: string;
  imageBase64: string;
  mimeType: string;
  backImageBase64: string | null;
  backMimeType: string | null;
  barcode: string | null;
  /** Product row already matched by barcode against our own catalog, if any. */
  localProduct: UnifiedProduct | null;
  localProductId: string | null;
}

function bandThresholds() {
  const high = Number(process.env.VECTOR_MATCH_HIGH);
  const low = Number(process.env.VECTOR_MATCH_LOW);
  return {
    high: Number.isFinite(high) ? high : 0.92,
    low: Number.isFinite(low) ? low : 0.82,
  };
}

// ─── Path A: National Foods ─────────────────────────────────────────────────

export async function runNationalRagPath(input: PathInput): Promise<PathOutcome> {
  const { high, low } = bandThresholds();

  // A barcode hit against our own catalog is already a confirmed identification
  // — no need to re-derive it from pixels.
  const vectorMatch = input.localProduct
    ? null
    : await findProductByImage(input.imageUrl, "National Foods");

  const matchedProduct =
    input.localProduct ??
    (vectorMatch
      ? {
          name: vectorMatch.product.product_name,
          brand: vectorMatch.product.brand_name,
          manufacturer: vectorMatch.product.brand_name,
          category: "Registered Product",
          barcode: vectorMatch.product.sku,
          size: "Standard",
          referenceImage: vectorMatch.product.reference_image_url || "",
        }
      : null);

  const similarity = vectorMatch?.similarity ?? null;

  // Gemini sees whichever reference we identified (may be null on a miss —
  // it then assesses the photo against generic packaging standards).
  const gemini = await compareImagesWithGemini(input.imageBase64, matchedProduct, input.mimeType, {
    data: input.backImageBase64,
    mimeType: input.backMimeType,
  });

  const apiSource: ApiSource = input.localProduct
    ? "LocalCatalog"
    : vectorMatch
      ? "ScraperMatch"
      : "none";

  // ── Bottom band ──────────────────────────────────────────────────────────
  // Either nothing came back, or what came back is below the low boundary.
  // The second case shouldn't normally happen (the RPC floor tracks
  // VECTOR_MATCH_LOW) but it's checked explicitly so a mis-set
  // VECTOR_MATCH_THRESHOLD can't smuggle a sub-threshold candidate into the
  // middle band and get it adjudicated as a probable match.
  const belowLowBand = similarity !== null && similarity < low;

  if (!matchedProduct || belowLowBand) {
    // "Not in the catalog" is only counterfeit evidence if the catalog is
    // actually populated. With zero embedded rows every scan would land here
    // and the failure would be indistinguishable from "everything is fake".
    const coverage = await nationalCatalogEmbeddingCount();
    if (coverage === 0) {
      return {
        product: null,
        apiSource: "none",
        dbProductId: null,
        vectorSimilarity: null,
        dbVerdict: "unverified",
        displayVerdict: "unverified",
        // 0, not gemini.confidence. The UI labels this field as authenticity
        // confidence; Gemini's confidence in its own visual read is a
        // different quantity, and surfacing "100%" next to "cannot verify"
        // would directly contradict the verdict beside it.
        score: 0,
        gemini,
        reasonEn:
          "Cannot verify: the National Foods reference catalogue has no indexed products yet, so there is nothing to compare this packaging against. Run the catalogue scraper and embedding backfill, then rescan.",
        reasonUr:
          "تصدیق ممکن نہیں: نیشنل فوڈز کے حوالہ جاتی کیٹلاگ میں ابھی کوئی مصنوع درج نہیں، اس لیے موازنہ نہیں کیا جا سکتا۔ کیٹلاگ اسکریپر چلانے کے بعد دوبارہ اسکین کریں۔",
      };
    }

    return {
      product: null,
      apiSource: "none",
      dbProductId: null,
      vectorSimilarity: similarity,
      dbVerdict: "suspicious",
      displayVerdict: "counterfeit",
      // Score means "how strongly this matches a catalogued genuine product"
      // on this path, so a catalogue miss is 0 — anything higher next to a
      // COUNTERFEIT headline reads as "0% fake / 100% authentic".
      score: 0,
      gemini,
      reasonEn:
        "This product was not found in the National Foods reference catalogue, and its packaging does not visually match any catalogued product.",
      reasonUr:
        "یہ مصنوع نیشنل فوڈز کے حوالہ جاتی کیٹلاگ میں نہیں ملی، اور اس کی پیکنگ کسی بھی درج شدہ مصنوع سے مماثلت نہیں رکھتی۔",
    };
  }

  const base = {
    product: matchedProduct,
    apiSource,
    dbProductId: input.localProductId ?? vectorMatch?.product.id ?? null,
    vectorSimilarity: similarity,
    gemini,
    // Similarity IS the evidence on this path, so it drives the displayed
    // score. A barcode-confirmed catalog row has no cosine score; treat the
    // exact SKU match as full confidence.
    score: similarity !== null ? Math.round(similarity * 100) : 100,
  };

  // ── Top band: confirmed catalog match ────────────────────────────────────
  // similarity === null means the barcode matched one of our own catalog rows
  // outright, which is a stronger identification than any cosine score.
  if (similarity === null || similarity >= high) {
    return {
      ...base,
      dbVerdict: "genuine",
      displayVerdict: "genuine",
      reasonEn: `Matched against the National Foods reference catalogue (${matchedProduct.name}). Packaging is consistent with the manufacturer's catalogued product.`,
      reasonUr: `نیشنل فوڈز کے حوالہ جاتی کیٹلاگ سے مطابقت پائی گئی (${matchedProduct.name})۔ پیکنگ کارخانہ دار کی درج شدہ مصنوع کے مطابق ہے۔`,
    };
  }

  // ── Middle band: probable match, adjudicate with a side-by-side ──────────
  // Don't guess — compareProductImages runs Gemini against the matched
  // reference image, and its sentence is the most convincing output the
  // pipeline produces, so it goes straight into `reason`.
  let adjudicationEn: string | null = null;
  let adjudicationUr: string | null = null;

  if (matchedProduct.referenceImage) {
    const cmp = await compareProductImages(input.imageUrl, matchedProduct.referenceImage, {
      product_name: matchedProduct.name,
      brand_name: matchedProduct.brand,
    });
    adjudicationEn = cmp.en;
    adjudicationUr = cmp.ur;
  }

  const visuallyConsistent =
    gemini.packagingMatch >= 70 && gemini.logoMatch >= 70 && !gemini.tampering;

  if (visuallyConsistent) {
    return {
      ...base,
      dbVerdict: "genuine",
      displayVerdict: "genuine",
      reasonEn:
        adjudicationEn ??
        `Probable catalogue match (${matchedProduct.name}); packaging and logo are consistent with the manufacturer's reference.`,
      reasonUr:
        adjudicationUr ??
        `ممکنہ کیٹلاگ مطابقت (${matchedProduct.name})؛ پیکنگ اور لوگو کارخانہ دار کے حوالے کے مطابق ہیں۔`,
    };
  }

  return {
    ...base,
    dbVerdict: "suspicious",
    displayVerdict: "counterfeit",
    reasonEn:
      adjudicationEn ??
      `Close but unconfirmed match against the National Foods catalogue; packaging or logo details differ from the manufacturer's reference.`,
    reasonUr:
      adjudicationUr ??
      `نیشنل فوڈز کیٹلاگ سے قریبی مگر غیر مصدقہ مطابقت؛ پیکنگ یا لوگو کی تفصیلات کارخانہ دار کے حوالے سے مختلف ہیں۔`,
  };
}

// ─── Path B: everything else ────────────────────────────────────────────────

export async function runExternalDbPath(input: PathInput): Promise<PathOutcome> {
  let product: UnifiedProduct | null = input.localProduct;
  let apiSource: ApiSource = input.localProduct ? "LocalCatalog" : "none";
  const cleanBarcode = input.barcode?.trim() || "";

  if (!product && cleanBarcode) {
    const cached = await getCachedProduct(cleanBarcode);
    if (cached) {
      product = cached;
      apiSource = "UPCItemDB";
    } else {
      product = await lookupUPCItemDB(cleanBarcode);
      if (product) {
        apiSource = "UPCItemDB";
      } else {
        product = await lookupOpenFoodFacts(cleanBarcode);
        if (product) {
          apiSource = "OpenFoodFacts";
        } else {
          product = await lookupBarcodeLookup(cleanBarcode);
          if (product) apiSource = "BarcodeLookup";
        }
      }
      if (product) await setCachedProduct(cleanBarcode, product);
    }
  }

  const gemini = await compareImagesWithGemini(input.imageBase64, product, input.mimeType, {
    data: input.backImageBase64,
    mimeType: input.backMimeType,
  });

  const comparison = runComparisonEngine(input.barcode, product, gemini);
  const score = calculateAuthenticityScore(comparison).score;

  const base = {
    product,
    apiSource,
    dbProductId: input.localProductId,
    vectorSimilarity: null,
    gemini,
    score,
  };

  // Every lookup missed. We have no reference image and no catalogue entry, so
  // we have no evidence either way — that is `unverified`, NOT counterfeit.
  // These databases have large coverage gaps; absence is not evidence.
  if (!product) {
    return {
      ...base,
      dbVerdict: "unverified",
      displayVerdict: "unverified",
      reasonEn:
        "No reference record for this product was found in the global barcode databases, so its authenticity could not be checked against a known original.",
      reasonUr:
        "عالمی بارکوڈ ڈیٹا بیس میں اس مصنوع کا کوئی حوالہ جاتی ریکارڈ نہیں ملا، اس لیے اصل سے موازنہ ممکن نہیں ہو سکا۔",
    };
  }

  if (score > 50) {
    return {
      ...base,
      dbVerdict: "genuine",
      displayVerdict: "genuine",
      reasonEn: gemini.reason,
      reasonUr: gemini.reasonUr,
    };
  }
  if (score < 10) {
    return {
      ...base,
      dbVerdict: "suspicious",
      displayVerdict: "counterfeit",
      reasonEn: gemini.reason,
      reasonUr: gemini.reasonUr,
    };
  }
  return {
    ...base,
    dbVerdict: "suspicious",
    displayVerdict: "suspicious",
    reasonEn: gemini.reason,
    reasonUr: gemini.reasonUr,
  };
}
