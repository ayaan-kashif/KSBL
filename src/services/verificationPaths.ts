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
import { nationalCatalogEmbeddingCount, type WordmarkStatus } from "./brandRouter";

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
  /** Wordmark classification from brandRouter — see WordmarkStatus. */
  wordmarkStatus?: WordmarkStatus;
  detectedBrand?: string | null;
  imitatedBrand?: string | null;
}

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
    });

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
      const visiblyWrong =
        gemini.tampering || gemini.logoMatch < 50 || gemini.packagingMatch < 50;

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
