/**
 * services/verificationPaths.ts
 *
 * The verification strategies /api/verify switches between. Routing lives
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
 *  Path C "medicine"      — medicines, detected conservatively from a GS1
 *                           DataMatrix, the medicine catalog or the packaging
 *                           (see detectMedicine). Off entirely when
 *                           MEDICINE_VERIFICATION_ENABLED=false.
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
import { nationalCatalogEmbeddingCount, prefixOwner, type WordmarkStatus } from "./brandRouter";
import type { BarcodeRead } from "./barcodeScanner";
import { runMedicineChecks, type MedicineAssessment, type MedicineDataSource } from "./medicineChecks";
import { supabaseMedicineData } from "./medicineData";
import { combineMedicineVerdict, type MedicineVerdict } from "./scoreEngine";
import { cloneDistanceKm, cloneMaxScans, MEDICINE_LOG } from "@/lib/medicineConfig";
import { assessBarcode, barcodeMismatchReason, isBarcodeMismatch, type BarcodeCheck } from "./barcodeEvidence";

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
export type VerificationPath = "national_rag" | "external_db" | "medicine";

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
  /** One-line barcode result shown beside the reason — see barcodeEvidence.ts. */
  barcodeCheck: BarcodeCheck;
  /** Medicine path only: printed fields, GS1 data and per-check results. */
  medicine?: MedicineAssessment;
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
  /** Wordmark classification from brandRouter — see WordmarkStatus. */
  wordmarkStatus?: WordmarkStatus;
  detectedBrand?: string | null;
  imitatedBrand?: string | null;
  /** The full barcode read (source/format) behind `barcode`, if any. */
  barcodeRead?: BarcodeRead | null;
  /** Wordmark read off the packaging, independent of the barcode. */
  packagingBrand?: string | null;
  /** Who scanned (customerReporterKey) and where — for the duplicate-serial check. */
  reporterKey?: string | null;
  area?: string | null;
  /** Medicine path only — clone-serial distance check and same-customer rule. */
  latitude?: number | null;
  longitude?: number | null;
  customerId?: string | null;
}

/** Path outcome before the barcode line is attached. */
type PathVerdict = Omit<PathOutcome, "barcodeCheck">;

/**
 * Authenticity score below which a scan is reported as suspicious on the
 * external-DB path, even when no reference record was found. Above it, a
 * missing record stays `unverified`.
 */
const SUSPICIOUS_SCORE_THRESHOLD = 50;

/**
 * Ceiling on the score reported alongside an `unverified` verdict.
 *
 * The number the result screen labels CONFIDENCE is confidence in the
 * *authenticity verdict*. When no reference record exists there is no evidence
 * either way, so that confidence is low by definition — regardless of how
 * clean the photograph looks. Passing Gemini's raw visual score straight
 * through produced screens reading "UNVERIFIED — authenticity could not be
 * confirmed either way" beside "78%", which invites exactly the reading the
 * verdict is trying to deny.
 */
const UNVERIFIED_MAX_SCORE = 39;

/**
 * Ceiling on "logo accuracy" once the wordmark is known to be misspelled. Not
 * zero: the logo's shape, colours and lockup genuinely are reproduced, and
 * that's the point — the mark is a close copy carrying the wrong name. It just
 * cannot read as a pass.
 */
const WORDMARK_FAIL_LOGO_CAP = 15;

/**
 * Rescale a visual score into the unverified band, preserving order so a
 * cleaner photo still ranks above a poor one, without ever implying we
 * verified anything.
 */
function unverifiedScore(visualScore: number): number {
  return Math.min(
    UNVERIFIED_MAX_SCORE,
    Math.max(0, Math.round(visualScore * (UNVERIFIED_MAX_SCORE / 100)))
  );
}

/**
 * Ceiling on the external-database lookups Path A runs purely as barcode
 * evidence. Path B awaits the same lookups as its primary source and keeps
 * their own behaviour.
 */
const EVIDENCE_LOOKUP_TIMEOUT_MS = 4000;

/** Resolve with null instead of waiting past `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/**
 * Something visibly wrong with the packaging itself. The corroboration a
 * counterfeit call needs beyond a number — see the near-miss band below.
 */
function packagingVisiblyWrong(gemini: GeminiComparisonResult): boolean {
  return gemini.tampering || gemini.logoMatch < 50 || gemini.packagingMatch < 50;
}

/** A ZXing-decoded product code, for geminiVision's reference barcode. */
function decodedProductCode(input: PathInput): string | null {
  return input.barcodeRead?.source === "decoded" ? input.barcodeRead.productCode : null;
}

/** cache -> UPCItemDB -> Open Food Facts -> Barcode Lookup. */
async function lookupExternalProduct(barcode: string): Promise<{ product: UnifiedProduct | null; apiSource: ApiSource }> {
  const cached = await getCachedProduct(barcode);
  if (cached) return { product: cached, apiSource: "UPCItemDB" };

  let apiSource: ApiSource = "none";
  let product = await lookupUPCItemDB(barcode);
  if (product) {
    apiSource = "UPCItemDB";
  } else {
    product = await lookupOpenFoodFacts(barcode);
    if (product) {
      apiSource = "OpenFoodFacts";
    } else {
      product = await lookupBarcodeLookup(barcode);
      if (product) apiSource = "BarcodeLookup";
    }
  }
  if (product) await setCachedProduct(barcode, product);
  return { product, apiSource };
}

/**
 * Feed the barcode result into a verdict the path has already reached.
 *
 *  - Mismatch: never genuine. Counterfeit only with the same corroboration a
 *    low-similarity scan needs (visible packaging defects); otherwise
 *    suspicious. A verdict that is already counterfeit on stronger evidence
 *    keeps its own reason.
 *  - Tampered (Path A only): a genuine verdict can't stand on a barcode from
 *    tampered packaging — downgraded to suspicious. Path B's verdict comes
 *    from scoreEngine, where the same signal already zeroes barcode credit.
 *
 * Scores follow the existing conventions: 0 beside a counterfeit headline,
 * the unverified band beside a suspicious one.
 */
function applyBarcodeEvidence(
  outcome: PathVerdict,
  input: PathInput,
  barcodeBrand: string | null,
  packagingBrand: string | null,
  downgradeTamperedGenuine = false
): PathOutcome {
  const read = input.barcodeRead ?? null;
  const code = read?.productCode ?? null;
  const barcodeCheck = assessBarcode({
    read,
    matched: !!code && !!outcome.product?.barcode && outcome.product.barcode.trim() === code,
    barcodeBrand,
    packagingBrand,
    tampering: outcome.gemini.tampering,
  });
  const withCheck: PathOutcome = { ...outcome, barcodeCheck };

  if (barcodeCheck.status === "mismatch" && code && barcodeBrand && packagingBrand) {
    if (outcome.displayVerdict === "counterfeit") return withCheck;
    const defects = packagingVisiblyWrong(outcome.gemini);
    const reason = barcodeMismatchReason(code, barcodeBrand, packagingBrand, defects);
    return {
      ...withCheck,
      dbVerdict: "suspicious",
      displayVerdict: defects ? "counterfeit" : "suspicious",
      score: defects ? 0 : unverifiedScore(outcome.score),
      reasonEn: reason.en,
      reasonUr: reason.ur,
    };
  }

  if (downgradeTamperedGenuine && barcodeCheck.status === "tampered" && outcome.displayVerdict === "genuine") {
    return {
      ...withCheck,
      dbVerdict: "suspicious",
      displayVerdict: "suspicious",
      score: unverifiedScore(outcome.score),
      reasonEn: `${outcome.reasonEn} However, the packaging shows signs of tampering, so its barcode and seal cannot be trusted. Inspect the pack before selling or buying.`,
      reasonUr: `${outcome.reasonUr} تاہم پیکنگ میں چھیڑ چھاڑ کے آثار ہیں، اس لیے اس کے بارکوڈ اور سیل پر اعتبار نہیں کیا جا سکتا۔ فروخت یا خریداری سے پہلے پیک کا معائنہ کریں۔`,
    };
  }

  return withCheck;
}

function bandThresholds() {
  const high = Number(process.env.VECTOR_MATCH_HIGH);
  const low = Number(process.env.VECTOR_MATCH_LOW);
  const nearMiss = Number(process.env.VECTOR_MATCH_NEAR_MISS);
  return {
    high: Number.isFinite(high) ? high : 0.92,
    low: Number.isFinite(low) ? low : 0.82,
    /**
     * Floor for "resembles a catalogued product without being it". CLIP cosine
     * between two photos of the SAME product lands ~0.80–0.95; a different
     * product from the same brand family sits lower but still well clear of an
     * unrelated object. Between this and `low` is where copies live: close
     * enough to be imitating the pack, too far to be it.
     */
    nearMiss: Number.isFinite(nearMiss) ? nearMiss : 0.55,
  };
}

// ─── Path A: National Foods ─────────────────────────────────────────────────

export async function runNationalRagPath(input: PathInput): Promise<PathOutcome> {
  // Which company the barcode belongs to — started now so the external
  // lookups overlap the vector search and Gemini call instead of adding to
  // them. Only for a decoded barcode: only that can raise a mismatch, and the
  // external databases are otherwise skipped on this path (a MISS there is
  // noise for National Foods; a HIT naming another company is evidence).
  const code = input.barcodeRead?.productCode ?? null;
  const barcodeBrandPromise: Promise<string | null> =
    input.barcodeRead?.source !== "decoded" || !code
      ? Promise.resolve(null)
      : (async () =>
          input.localProduct?.brand ??
          (await prefixOwner(code)) ??
          (await within(lookupExternalProduct(code), EVIDENCE_LOOKUP_TIMEOUT_MS))?.product?.brand ??
          null)();

  const outcome = await nationalRagVerdict(input);

  // The vector search on this path is filtered to National Foods, so any
  // similarity at all means the packaging was matched against that brand.
  const packagingBrand =
    input.packagingBrand ?? (outcome.vectorSimilarity !== null ? "National Foods" : null);

  return applyBarcodeEvidence(outcome, input, await barcodeBrandPromise, packagingBrand, true);
}

async function nationalRagVerdict(input: PathInput): Promise<PathVerdict> {
  const { high, low, nearMiss } = bandThresholds();

  // ── Misspelled wordmark ────────────────────────────────────────────────────
  // Decided before any catalogue work, and deliberately independent of it. A
  // pack printed "Nationel" is not National Foods' product no matter what the
  // vector search says, and unlike every other signal here this one needs no
  // embeddings — it is the only conclusive check that works while the
  // catalogue is still unindexed.
  if (input.wordmarkStatus === "near_miss") {
    const printed = input.detectedBrand ?? "the printed brand name";
    const genuine = input.imitatedBrand
      ? input.imitatedBrand.replace(/\b\w/g, (c) => c.toUpperCase())
      : "National";
    const rawGemini = await compareImagesWithGemini(input.imageBase64, null, input.mimeType, {
      data: input.backImageBase64,
      mimeType: input.backMimeType,
    }, decodedProductCode(input));

    // The result screen renders these as "BRAND FONTS", "LOGO ACCURACY" etc —
    // percentages that answer "does this match the genuine article". A
    // misspelled wordmark answers that definitively for the two of them that
    // depend on the brand name, and the model's own impression does not get to
    // overrule hard evidence: left alone it reported BRAND FONTS 100% on a pack
    // printed "Nationel", directly contradicting the COUNTERFEIT headline above
    // it. Layout and packaging scores are deliberately NOT touched — a good
    // copy really does reproduce those, and "the design is a near-perfect match
    // but the brand name is misspelled" is both true and the clearest way to
    // show how the fake was caught.
    const gemini = {
      ...rawGemini,
      brandMatch: 0,
      logoMatch: Math.min(rawGemini.logoMatch, WORDMARK_FAIL_LOGO_CAP),
      confidence: 0,
    };

    return {
      product: null,
      apiSource: "none",
      dbProductId: null,
      vectorSimilarity: null,
      dbVerdict: "suspicious",
      displayVerdict: "counterfeit",
      score: 0,
      gemini,
      reasonEn: `The brand name printed on this packaging reads "${printed}", which is a misspelling of "${genuine}". A genuine manufacturer does not misspell its own trademark; near-identical misspellings are a standard counterfeit tactic to imitate a trusted brand while evading trademark checks. This is a counterfeit product.`,
      reasonUr: `اس پیکنگ پر چھپا ہوا برانڈ کا نام "${printed}" ہے، جو "${genuine}" کا غلط ہجہ ہے۔ اصل کارخانہ دار اپنے ہی ٹریڈ مارک کا ہجہ غلط نہیں لکھتا؛ ملتے جلتے غلط ہجے نقلی مصنوعات کا معروف طریقہ ہیں تاکہ معتبر برانڈ کی نقل کی جا سکے۔ یہ ایک نقلی مصنوع ہے۔`,
    };
  }

  // A barcode hit against our own catalog is already a confirmed identification
  // — no need to re-derive it from pixels.
  //
  // The RPC floor is deliberately `nearMiss`, not `low`: querying at `low`
  // would return nothing for a copy that imitates the pack without matching
  // it, and that scan would then be indistinguishable from an unrelated
  // product. Fetching the nearest neighbour and banding it here keeps the
  // near-miss evidence instead of discarding it in the database.
  const vectorMatch = input.localProduct
    ? null
    : await findProductByImage(input.imageUrl, "National Foods", nearMiss);

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
  }, decodedProductCode(input));

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
    // ── Near miss ──────────────────────────────────────────────────────────
    // A catalogued product IS the closest thing to this scan, but the packaging
    // doesn't actually match it. That combination is the signature of a copy:
    // an unrelated product wouldn't resemble the catalogue at all, and a
    // genuine one would clear `low`. Report it as counterfeit and say which
    // product it is imitating — far more useful than a bare "not found".
    if (matchedProduct && similarity !== null && similarity >= nearMiss) {
      const pct = Math.round(similarity * 100);

      // Corroborate before accusing. Cosine similarity between two REAL
      // photographs of the SAME pack swings hard on framing, background,
      // distance and lighting — a genuine product shot against a cluttered
      // background lands far below `low` on its own reference image. Calling
      // that counterfeit on the number alone is the most damaging mistake this
      // app can make, so a low score is only escalated when something visible
      // is actually wrong with the packaging.
      const visiblyWrong = packagingVisiblyWrong(gemini);

      if (!visiblyWrong) {
        return {
          product: null,
          apiSource: "none",
          dbProductId: null,
          vectorSimilarity: similarity,
          dbVerdict: "suspicious",
          displayVerdict: "suspicious",
          score: unverifiedScore(pct),
          gemini,
          reasonEn: `This packaging is only a ${pct}% visual match to the closest National Foods catalogue entry ("${matchedProduct.name}"), below the ${Math.round(low * 100)}% needed to confirm it, but no specific packaging defect was found. That combination is common when a genuine product is photographed at an unusual angle, distance or lighting. Rescan the front of the pack, filling the frame against a plain background.`,
          reasonUr: `یہ پیکنگ نیشنل فوڈز کے قریب ترین کیٹلاگ اندراج ("${matchedProduct.name}") سے صرف ${pct}% مماثل ہے، جو تصدیق کے لیے درکار ${Math.round(low * 100)}% سے کم ہے، مگر پیکنگ میں کوئی مخصوص خرابی نہیں ملی۔ ایسا اکثر اُس وقت ہوتا ہے جب اصل مصنوع کو غیر معمولی زاویے، فاصلے یا روشنی میں تصویر کیا جائے۔ سادہ پس منظر کے سامنے پیک کا اگلا حصہ پورے فریم میں لے کر دوبارہ اسکین کریں۔`,
        };
      }

      return {
        // Deliberately null: this scan is NOT that catalogue product, and
        // returning it here would make the UI label the fake with the genuine
        // product's name. The resemblance is reported in the reason instead.
        product: null,
        apiSource: "none",
        dbProductId: null,
        vectorSimilarity: similarity,
        dbVerdict: "suspicious",
        displayVerdict: "counterfeit",
        score: 0,
        gemini,
        reasonEn: `This packaging resembles the National Foods product "${matchedProduct.name}" (${pct}% visual similarity) but does not match the manufacturer's catalogued packaging closely enough to be that product, and the packaging itself shows defects. A genuine pack scores at least ${Math.round(low * 100)}%. This is most likely a counterfeit imitating ${matchedProduct.name}.`,
        reasonUr: `یہ پیکنگ نیشنل فوڈز کی مصنوع "${matchedProduct.name}" سے مشابہت رکھتی ہے (${pct}% بصری مماثلت) مگر کارخانہ دار کی درج شدہ پیکنگ سے اتنی مطابقت نہیں رکھتی کہ یہ وہی مصنوع ہو، اور پیکنگ میں خرابیاں بھی موجود ہیں۔ اصل پیک کم از کم ${Math.round(low * 100)}% حاصل کرتا ہے۔ یہ غالباً ${matchedProduct.name} کی نقل ہے۔`,
      };
    }

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
    ({ product, apiSource } = await lookupExternalProduct(cleanBarcode));
  }

  const gemini = await compareImagesWithGemini(input.imageBase64, product, input.mimeType, {
    data: input.backImageBase64,
    mimeType: input.backMimeType,
  }, decodedProductCode(input));

  // The record found here IS the barcode's record, so its brand (or the
  // catalog row's, or an exclusive GS1 prefix's) is what the barcode says.
  const barcodeBrand =
    input.barcodeRead?.source === "decoded" && cleanBarcode
      ? product?.brand ?? (await prefixOwner(cleanBarcode))
      : null;
  const packagingBrand = input.packagingBrand ?? null;

  const comparison = runComparisonEngine(input.barcode, product, gemini, {
    detected: !!input.barcodeRead,
    mismatch: isBarcodeMismatch(input.barcodeRead ?? null, barcodeBrand, packagingBrand),
    tampered: !!input.barcodeRead && gemini.tampering,
  });
  const score = calculateAuthenticityScore(comparison).score;

  return applyBarcodeEvidence(
    externalDbVerdict(product, apiSource, input, gemini, score),
    input,
    barcodeBrand,
    packagingBrand
  );
}

function externalDbVerdict(
  product: UnifiedProduct | null,
  apiSource: ApiSource,
  input: PathInput,
  gemini: GeminiComparisonResult,
  score: number
): PathVerdict {
  const base = {
    product,
    apiSource,
    dbProductId: input.localProductId,
    vectorSimilarity: null,
    gemini,
    score,
  };

  // Every lookup missed, so there's no reference record to compare against.
  // Database absence on its own is not evidence — coverage gaps are large for
  // local FMCG — but the score here is Gemini's read of the packaging itself,
  // which is evidence about the product. A visibly poor result stays flagged
  // rather than being softened into "we couldn't check".
  if (!product) {
    if (score < SUSPICIOUS_SCORE_THRESHOLD) {
      return {
        ...base,
        dbVerdict: "suspicious",
        // Deliberately NOT "counterfeit": with no reference record we can't
        // substantiate that call, only report that the packaging scores badly.
        displayVerdict: "suspicious",
        reasonEn: `No reference record for this product was found in the global barcode databases, and its packaging scored ${score}% on visual authenticity checks — below the ${SUSPICIOUS_SCORE_THRESHOLD}% threshold. Treat this product as suspicious.`,
        reasonUr: `عالمی بارکوڈ ڈیٹا بیس میں اس مصنوع کا کوئی حوالہ جاتی ریکارڈ نہیں ملا، اور اس کی پیکنگ نے بصری جانچ میں ${score}% حاصل کیے — جو ${SUSPICIOUS_SCORE_THRESHOLD}% کی حد سے کم ہے۔ اس مصنوع کو مشکوک سمجھیں۔`,
      };
    }
    return {
      ...base,
      dbVerdict: "unverified",
      displayVerdict: "unverified",
      // Not `score`: see UNVERIFIED_MAX_SCORE.
      score: unverifiedScore(score),
      reasonEn:
        "No reference record for this product was found in the global barcode databases, so its authenticity could not be checked against a known original.",
      reasonUr:
        "عالمی بارکوڈ ڈیٹا بیس میں اس مصنوع کا کوئی حوالہ جاتی ریکارڈ نہیں ملا، اس لیے اصل سے موازنہ ممکن نہیں ہو سکا۔",
    };
  }

  if (score > SUSPICIOUS_SCORE_THRESHOLD) {
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

// ─── Path C: medicine ───────────────────────────────────────────────────────

export interface MedicineScanInput {
  imageBase64: string;
  mimeType: string;
  backImageBase64?: string | null;
  backMimeType?: string | null;
  /** The barcode read whose GS1 data the checks use (front, or the back DataMatrix). */
  barcodeRead: BarcodeRead | null;
  area: string | null;
  latitude?: number | null;
  longitude?: number | null;
  customerId?: string | null;
  /** customerReporterKey() / phoneReporterKey(). */
  reporterKey?: string | null;
}

export interface MedicineScanResult {
  gemini: GeminiComparisonResult;
  medicine: MedicineAssessment;
  verdict: MedicineVerdict;
}

/**
 * The medicine assessment both pipelines share (/api/verify's medicine path
 * and lib/verifyProduct.ts for WhatsApp / /api/scan): one Gemini call — the
 * same packaging comparison the other paths make, plus the medicine prompt
 * block (printed fields + pharma packaging flags) — then the checks in
 * services/medicineChecks.ts and the verdict from combineMedicineVerdict().
 */
export async function assessMedicineScan(
  input: MedicineScanInput,
  data: MedicineDataSource = supabaseMedicineData
): Promise<MedicineScanResult> {
  const hasBack = !!(input.backImageBase64 && input.backMimeType);
  const decodedCode = input.barcodeRead?.source === "decoded" ? input.barcodeRead.productCode : null;
  const gemini = await compareImagesWithGemini(
    input.imageBase64,
    null,
    input.mimeType,
    hasBack ? { data: input.backImageBase64!, mimeType: input.backMimeType! } : undefined,
    decodedCode,
    { medicine: true }
  );

  const medicine = await runMedicineChecks(
    {
      gs1: input.barcodeRead?.gs1 ?? null,
      productCode: input.barcodeRead?.productCode ?? null,
      printed: gemini.printed ?? null,
      gemini,
      hasBackImage: hasBack,
      current: {
        area: input.area,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        customerId: input.customerId ?? null,
        reporter: input.reporterKey ?? null,
      },
      clone: { maxKm: cloneDistanceKm(), maxScans: cloneMaxScans() },
    },
    data
  );
  const verdict = combineMedicineVerdict(medicine.checks, { has2dCode: medicine.has2dCode });
  medicine.verdict = verdict;
  console.log(
    `${MEDICINE_LOG} verdict=${verdict.status} score=${verdict.score} 2d=${medicine.has2dCode} ` +
      medicine.checks.map((c) => `${c.id}:${c.status}`).join(" ")
  );
  return { gemini, medicine, verdict };
}

/** What the result screens show as "the product" for a medicine. */
export function medicineToUnified(m: MedicineAssessment): UnifiedProduct | null {
  const c = m.identity.product;
  const p = m.printed;
  const name = c?.product_name ?? p?.brandName ?? null;
  if (!name) return null;
  const strength = c?.strength ?? p?.strength ?? null;
  return {
    name: strength && !name.includes(strength) ? `${name} ${strength}` : name,
    brand: name,
    manufacturer: c?.manufacturer ?? p?.manufacturer ?? "Unknown",
    category: "Medicine",
    barcode: m.gs1?.gtin ?? "",
    size: p?.packSize ?? "Standard",
    referenceImage: "",
  };
}

/**
 * Medicines are routed here by detectMedicine() in brandRouter.ts. The caller
 * wraps this in try/catch and falls back to the existing path on any error,
 * so a medicine failure can never turn into a 500.
 */
export async function runMedicinePath(input: PathInput): Promise<PathOutcome> {
  const { gemini, medicine, verdict } = await assessMedicineScan({
    imageBase64: input.imageBase64,
    mimeType: input.mimeType,
    backImageBase64: input.backImageBase64,
    backMimeType: input.backMimeType,
    barcodeRead: input.barcodeRead ?? null,
    area: input.area ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    customerId: input.customerId ?? null,
    reporterKey: input.reporterKey ?? null,
  });

  const outcome = applyBarcodeEvidence(
    {
      product: medicineToUnified(medicine),
      apiSource: medicine.identity.product ? "LocalCatalog" : "none",
      // Scan.product_id references Product, so only a Product row may go
      // here — never a Medicine-table id.
      dbProductId: input.localProductId ?? null,
      vectorSimilarity: null,
      dbVerdict: verdict.dbVerdict,
      displayVerdict: verdict.displayVerdict,
      score: verdict.score,
      gemini,
      reasonEn: verdict.reasonEn,
      reasonUr: verdict.reasonUr,
    },
    input,
    null,
    null
  );
  return { ...outcome, medicine };
}
