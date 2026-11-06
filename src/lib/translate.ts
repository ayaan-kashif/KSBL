/**
 * lib/translate.ts
 *
 * Fixed-glossary verdict phrasing in Urdu and English.
 *
 * Strategy: the verdict enum (genuine | suspicious | unverified) maps
 * to a pre-approved bilingual phrase pair. Gemini is optionally called
 * to generate a one-sentence contextual reason — but the verdict text
 * itself is NEVER free-translated; it comes from the lookup table only.
 * This prevents hallucinated or offensive Urdu output.
 *
 * Required env vars (optional — fallback works without any):
 *   GEMINI_API_KEY — Google Gemini API key for reason generation
 *
 * Direct REST API fetch call is used to call Gemini (model: gemini-2.5-flash)
 * to keep the bundle lean and serverless-native.
 */

// ─── Shared types ─────────────────────────────────────────────────────────────

export type VerdictKey = "genuine" | "suspicious" | "unverified";

/** A reason sentence in both languages. */
export interface BilingualReason {
  en: string;
  ur: string;
}

export interface VerdictText {
  urdu_text: string;
  english_text: string;
  reason_en: string;
  reason_ur: string;
  /** Alias of reason_en. Kept so existing API consumers that read
   *  `reason` keep working unchanged. */
  reason: string;
}

const GLOSSARY: Record<VerdictKey, { urdu: string; english: string }> = {
  genuine: {
    urdu: "✅ اصل مصنوع — یہ مصنوع معتبر ہے",
    english: "✅ Genuine Product — This product has been verified as authentic",
  },
  suspicious: {
    urdu: "⚠️ مشکوک — یہ مصنوع جعلی ہو سکتی ہے، فروخت یا خریداری سے گریز کریں",
    english:
      "⚠️ Suspicious — This product may be counterfeit. Avoid selling or purchasing.",
  },
  unverified: {
    urdu: "❓ غیر تصدیق شدہ — یہ مصنوع ہمارے ڈیٹا بیس میں موجود نہیں",
    english:
      "❓ Unverified — This product was not found in our manufacturer database",
  },
};

// ─── Gemini reason generation ────────────────────────────────────────────────

/**
 * Strip markdown fences and pull a {"en","ur"} pair out of a model response.
 * Never throws — returns null when the payload isn't usable, so callers can
 * fall back to the fixed bilingual defaults.
 */
function parseBilingualJson(raw: string): BilingualReason | null {
  if (!raw) return null;
  let text = raw.trim();

  // Gemini sometimes ignores the "no fences" instruction.
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  // Or wraps the object in prose — take the outermost braces.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) text = text.slice(first, last + 1);

  try {
    const parsed = JSON.parse(text);
    const en = typeof parsed?.en === "string" ? parsed.en.trim() : "";
    const ur = typeof parsed?.ur === "string" ? parsed.ur.trim() : "";
    // Require BOTH: a half-filled pair would render one language blank on
    // screen, which is worse than showing the fixed default in both.
    if (!en || !ur) return null;
    return { en, ur };
  } catch {
    return null;
  }
}

async function callGemini(
  verdict: VerdictKey,
  context: {
    batch?: string | null;
    anomaly_score?: number | null;
    brand_name?: string | null;
  }
): Promise<BilingualReason> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return getDefaultReason(verdict, context);

  try {
    const prompt = `You are a product authenticity assistant for ShelfWatch, an anti-counterfeit system for Pakistan's FMCG market.

A product scan returned verdict: "${verdict}"
Batch number detected: ${context.batch ?? "N/A"}
Packaging anomaly score (0=genuine, 1=suspicious): ${context.anomaly_score?.toFixed(2) ?? "N/A"}
Brand: ${context.brand_name ?? "Unknown"}

Explain the reason for this verdict in ONE concise sentence, in BOTH English and Urdu.
Be factual, not alarming. Maximum 20 words per language.
The Urdu must be natural Urdu script (not transliteration) and must convey the
same meaning as the English — it is not required to be a word-for-word translation.
Keep any batch codes, barcodes and numbers in Latin digits in both languages.

Return ONE raw JSON object and nothing else — no markdown code fences, no commentary:
{"en": "...", "ur": "..."}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;

    // 4-second timeout controller for API fetch call
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
        // Ask for JSON directly so the fence-stripping in parseBilingualJson
        // is a fallback rather than the primary path.
        generationConfig: { responseMimeType: "application/json" },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[Translate] Gemini returned status ${response.status}`);
      return getDefaultReason(verdict, context);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    return parseBilingualJson(text) ?? getDefaultReason(verdict, context);
  } catch (err) {
    console.error("[Translate] Gemini call failed or timed out:", err);
    return getDefaultReason(verdict, context);
  }
}

/**
 * Fixed bilingual fallback used whenever Gemini is unavailable, times out, or
 * returns something unparseable. Bilingual on this path too — otherwise the
 * no-API-key demo silently degrades to English-only.
 *
 * Batch codes and percentages stay in Latin digits in both languages.
 */
function getDefaultReason(
  verdict: VerdictKey,
  context: {
    batch?: string | null;
    anomaly_score?: number | null;
    brand_name?: string | null;
  }
): BilingualReason {
  switch (verdict) {
    case "genuine": {
      const batch = context.batch ?? "pattern";
      return {
        en: `Batch ${batch} matches manufacturer records and packaging appears authentic.`,
        ur: `بیچ ${batch} کارخانہ دار کے ریکارڈ سے مطابقت رکھتا ہے اور پیکنگ اصل معلوم ہوتی ہے۔`,
      };
    }
    case "suspicious": {
      const pct = ((context.anomaly_score ?? 0.5) * 100).toFixed(0);
      return {
        en: `Packaging anomaly score ${pct}% — batch or visual indicators suggest potential counterfeit.`,
        ur: `پیکنگ میں بے قاعدگی کا اسکور ${pct}% — بیچ یا ظاہری علامات ممکنہ جعل سازی کی نشاندہی کرتی ہیں۔`,
      };
    }
    case "unverified":
      return {
        en: "No matching product record found; manual verification recommended.",
        ur: "کوئی مماثل مصنوع کا ریکارڈ نہیں ملا؛ دستی تصدیق کی سفارش کی جاتی ہے۔",
      };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get bilingual verdict text and an optional AI-generated reason.
 * The verdict pair is always from the fixed glossary — never hallucinated.
 */
export async function getVerdictText(
  verdict: VerdictKey,
  context: {
    batch?: string | null;
    anomaly_score?: number | null;
    brand_name?: string | null;
  } = {}
): Promise<VerdictText> {
  const phrase = GLOSSARY[verdict];
  const reason = await callGemini(verdict, context);

  return {
    urdu_text: phrase.urdu,
    english_text: phrase.english,
    reason_en: reason.en,
    reason_ur: reason.ur,
    reason: reason.en,
  };
}

/**
 * Synchronous fallback — returns glossary text without Gemini.
 * Use when you need an instant response and can't await.
 */
export function getVerdictTextSync(
  verdict: VerdictKey
): Pick<VerdictText, "urdu_text" | "english_text"> {
  return {
    urdu_text: GLOSSARY[verdict].urdu,
    english_text: GLOSSARY[verdict].english,
  };
}

// ─── Barcode check line ───────────────────────────────────────────────────────

/** Outcome of the barcode check — see services/barcodeEvidence.ts. */
export type BarcodeCheckStatus = "verified" | "mismatch" | "tampered" | "unconfirmed" | "not_visible";

/** Fixed like GLOSSARY: shown as one extra line beside the verdict reason and
 *  in the WhatsApp reply, so it is never free-translated. */
const BARCODE_CHECK_GLOSSARY: Record<BarcodeCheckStatus, BilingualReason> = {
  verified: { ur: "بارکوڈ تصدیق شدہ ✓", en: "Barcode verified ✓" },
  mismatch: { ur: "بارکوڈ اس پروڈکٹ سے میل نہیں کھاتا ✗", en: "Barcode does not match this product ✗" },
  tampered: { ur: "پیکنگ میں چھیڑ چھاڑ — بارکوڈ قابلِ اعتبار نہیں ✗", en: "Packaging tampered — barcode not trusted ✗" },
  unconfirmed: { ur: "بارکوڈ پڑھا گیا — ریکارڈ میں موجود نہیں", en: "Barcode read — not in our records" },
  not_visible: { ur: "بارکوڈ نظر نہیں آیا", en: "Barcode not visible" },
};

export function getBarcodeCheckText(status: BarcodeCheckStatus): BilingualReason {
  return BARCODE_CHECK_GLOSSARY[status];
}

// ─── Medicine path ────────────────────────────────────────────────────────────

/**
 * One line per medicine check (services/medicineChecks.ts), fixed like
 * GLOSSARY — only dates, codes, names and counts are interpolated, in Latin
 * digits in both languages.
 */
export const MEDICINE_CHECK_TEXT = {
  gtinValid: { en: "Product code (GTIN) check digit is valid", ur: "پروڈکٹ کوڈ (GTIN) کا چیک ڈیجٹ درست ہے" } satisfies BilingualReason,
  gtinInvalid: (gtin: string): BilingualReason => ({
    en: `Product code ${gtin} has an invalid check digit — a genuine printing line cannot produce this`,
    ur: `پروڈکٹ کوڈ ${gtin} کا چیک ڈیجٹ غلط ہے — اصل پرنٹنگ میں ایسا نہیں ہو سکتا`,
  }),
  expired: (date: string): BilingualReason => ({
    en: `Expired on ${date} — do not use`,
    ur: `میعاد ${date} کو ختم ہو چکی — استعمال نہ کریں`,
  }),
  expiringSoon: (date: string, days: number): BilingualReason => ({
    en: `Expires on ${date} (in ${days} day${days === 1 ? "" : "s"})`,
    ur: `میعاد ${date} کو ختم ہو رہی ہے (${days} دن باقی)`,
  }),
  expiryFarOff: (date: string): BilingualReason => ({
    en: `Expiry ${date} is unusually far away (more than 6 years) — check the date on the pack`,
    ur: `میعاد ${date} غیر معمولی طور پر دور ہے (6 سال سے زیادہ) — پیک پر تاریخ دیکھیں`,
  }),
  expiryOk: (date: string): BilingualReason => ({
    en: `Not expired (expires ${date})`,
    ur: `میعاد ختم نہیں ہوئی (میعاد ${date})`,
  }),
  mfgAfterExpiry: (mfg: string, expiry: string): BilingualReason => ({
    en: `Manufacturing date ${mfg} is not before the expiry ${expiry}`,
    ur: `تاریخِ تیاری ${mfg} میعاد ${expiry} سے پہلے نہیں`,
  }),
  mfgInFuture: (mfg: string): BilingualReason => ({
    en: `Manufacturing date ${mfg} is in the future`,
    ur: `تاریخِ تیاری ${mfg} مستقبل کی ہے`,
  }),
  mfgOk: { en: "Manufacturing and expiry dates are consistent", ur: "تاریخِ تیاری اور میعاد میں مطابقت ہے" } satisfies BilingualReason,
  batchMismatch: (printed: string, coded: string): BilingualReason => ({
    en: `Batch printed on the pack (${printed}) does not match the 2D code (${coded})`,
    ur: `پیک پر چھپا بیچ (${printed}) 2D کوڈ (${coded}) سے مختلف ہے`,
  }),
  batchMatch: { en: "Batch on the pack matches the 2D code", ur: "پیک پر بیچ 2D کوڈ کے مطابق ہے" } satisfies BilingualReason,
  expiryMismatch: (printed: string, coded: string): BilingualReason => ({
    en: `Expiry printed on the pack (${printed}) does not match the 2D code (${coded})`,
    ur: `پیک پر چھپی میعاد (${printed}) 2D کوڈ (${coded}) سے مختلف ہے`,
  }),
  expiryMatch: { en: "Expiry on the pack matches the 2D code", ur: "پیک پر میعاد 2D کوڈ کے مطابق ہے" } satisfies BilingualReason,
  packagingOk: { en: "No packaging defects seen", ur: "پیکنگ میں کوئی خرابی نظر نہیں آئی" } satisfies BilingualReason,
  packagingIssues: (en: string, ur: string): BilingualReason => ({
    en: `Packaging problems: ${en}`,
    ur: `پیکنگ کے مسائل: ${ur}`,
  }),
  cloned: (area: string): BilingualReason => ({
    en: `This serial was already scanned in ${area}, so the code is likely copied`,
    ur: `یہ سیریل پہلے ہی ${area} میں اسکین ہو چکا ہے، اس لیے کوڈ غالباً نقل شدہ ہے`,
  }),
  clonedFar: (km: number): BilingualReason => ({
    en: `This serial was already scanned ${km} km away, so the code is likely copied`,
    ur: `یہ سیریل پہلے ہی ${km} کلومیٹر دور اسکین ہو چکا ہے، اس لیے کوڈ غالباً نقل شدہ ہے`,
  }),
  serialRepeated: (count: number): BilingualReason => ({
    en: `This serial has been scanned ${count} times in this area — a single pack is rarely scanned this often`,
    ur: `یہ سیریل اس علاقے میں ${count} بار اسکین ہو چکا ہے — ایک پیک اتنی بار کم ہی اسکین ہوتا ہے`,
  }),
  serialFirst: { en: "First scan of this serial number", ur: "اس سیریل نمبر کا پہلا اسکین" } satisfies BilingualReason,
  serialSeenHere: (count: number): BilingualReason => ({
    en: `Serial seen ${count} time${count === 1 ? "" : "s"} before, only in this area`,
    ur: `یہ سیریل پہلے ${count} بار، صرف اسی علاقے میں دیکھا گیا`,
  }),
  regFound: (regNo: string, brand: string): BilingualReason => ({
    en: `DRAP Reg. No. ${regNo} matches ${brand}`,
    ur: `ڈریپ رجسٹریشن نمبر ${regNo} ${brand} سے مطابقت رکھتا ہے`,
  }),
  regMismatch: (regNo: string, brand: string): BilingualReason => ({
    en: `DRAP Reg. No. ${regNo} is registered to ${brand}, not to this product`,
    ur: `ڈریپ رجسٹریشن نمبر ${regNo} ${brand} کا ہے، اس مصنوع کا نہیں`,
  }),
  regNotFound: (regNo: string): BilingualReason => ({
    en: `Reg. No. ${regNo} is not in our DRAP list — verify with the pharmacist`,
    ur: `رجسٹریشن نمبر ${regNo} ہماری ڈریپ فہرست میں نہیں — فارماسسٹ سے تصدیق کریں`,
  }),
  catalogMatch: (brand: string): BilingualReason => ({
    en: `Product code matches ${brand} in the medicine catalogue`,
    ur: `پروڈکٹ کوڈ دواؤں کے کیٹلاگ میں ${brand} سے مطابقت رکھتا ہے`,
  }),
  catalogMismatch: (brand: string): BilingualReason => ({
    en: `Product code belongs to ${brand} in the medicine catalogue, not to this pack`,
    ur: `پروڈکٹ کوڈ کیٹلاگ میں ${brand} کا ہے، اس پیک کا نہیں`,
  }),
  drapFlagged: (product: string, batch: string, type: string, date: string): BilingualReason => ({
    en: `Flagged by DRAP: ${product} batch ${batch} (${type}, ${date})`,
    ur: `ڈریپ کی جانب سے نشاندہی: ${product} بیچ ${batch} (${type}، ${date})`,
  }),
  drapProductAlert: (product: string, date: string): BilingualReason => ({
    en: `DRAP issued an alert for other batches of ${product} (${date}) — check the batch with your pharmacist`,
    ur: `ڈریپ نے ${product} کے دوسرے بیچوں کے لیے الرٹ جاری کیا (${date}) — فارماسسٹ سے بیچ چیک کروائیں`,
  }),
  drapNoAlert: { en: "No DRAP alert for this product", ur: "اس مصنوع کے لیے ڈریپ کا کوئی الرٹ نہیں" } satisfies BilingualReason,
  registryValid: { en: "Serial confirmed by the GS1 / DRAP registry", ur: "سیریل کی GS1 / ڈریپ رجسٹری سے تصدیق ہو گئی" } satisfies BilingualReason,
  registryInvalid: { en: "The GS1 / DRAP registry does not recognise this serial", ur: "GS1 / ڈریپ رجسٹری اس سیریل کو تسلیم نہیں کرتی" } satisfies BilingualReason,
  /** Skipped checks are stored but never shown. */
  skipped: (why: string): BilingualReason => ({ en: `Not checked: ${why}`, ur: `جانچ نہیں ہوئی: ${why}` }),
  no2dCode: { en: "No 2D code (older stock?)", ur: "کوئی 2D کوڈ نہیں (پرانا اسٹاک؟)" } satisfies BilingualReason,
};

/** Packaging defect labels for MEDICINE_CHECK_TEXT.packagingIssues. */
export const PHARMA_PACKAGING_ISSUE_TEXT: Record<string, BilingualReason> = {
  blurryPrint: { en: "blurry print", ur: "دھندلی چھپائی" },
  blisterFoilDefect: { en: "blister/foil looks wrong", ur: "بلسٹر/فوائل درست نہیں" },
  sealBroken: { en: "broken or tampered seal", ur: "ٹوٹی یا چھیڑی ہوئی سیل" },
  spellingErrors: { en: "spelling mistakes", ur: "ہجے کی غلطیاں" },
  logoMismatch: { en: "logo differs from the genuine one", ur: "لوگو اصل سے مختلف" },
  stripBoxMismatch: { en: "strip and box don't match", ur: "پٹی اور ڈبہ مطابقت نہیں رکھتے" },
  missingRegNo: { en: "no DRAP Reg. No.", ur: "ڈریپ رجسٹریشن نمبر موجود نہیں" },
  missingUrduOrMrp: { en: "no Urdu text or MRP", ur: "اردو تحریر یا قیمت موجود نہیں" },
  missingKeepOutOfReach: { en: "no \"Keep out of reach of children\" warning", ur: "\"بچوں کی پہنچ سے دور رکھیں\" کی ہدایت موجود نہیں" },
  tampering: { en: "signs of tampering", ur: "چھیڑ چھاڑ کے آثار" },
};

/** Medicine headline phrases. Mirrors MEDICINE_COPY in lib/verdictCopy.ts — keep in sync. */
export const MEDICINE_VERDICT_TEXT = {
  noProblems: {
    en: "✅ No red flags found. Confirm with your pharmacist.",
    ur: "✅ کوئی خطرے کی علامت نہیں ملی۔ اپنے فارماسسٹ سے تصدیق کریں۔",
  } satisfies BilingualReason,
  counterfeit: {
    en: "⛔ Do not use this medicine — it shows signs of a fake. Report it to DRAP.",
    ur: "⛔ یہ دوا استعمال نہ کریں — اس میں نقلی ہونے کی علامات ہیں۔ ڈریپ کو اطلاع دیں۔",
  } satisfies BilingualReason,
  suspicious: {
    en: "⚠️ Suspicious medicine — do not take it until a pharmacist has checked it, and report it to DRAP.",
    ur: "⚠️ مشکوک دوا — فارماسسٹ کی جانچ تک نہ لیں، اور ڈریپ کو اطلاع دیں۔",
  } satisfies BilingualReason,
  expired: {
    en: "⛔ Expired — do not use.",
    ur: "⛔ میعاد ختم — استعمال نہ کریں۔",
  } satisfies BilingualReason,
  unverified: {
    en: "❓ This medicine could not be fully checked. Confirm with your pharmacist.",
    ur: "❓ اس دوا کی مکمل جانچ نہیں ہو سکی۔ اپنے فارماسسٹ سے تصدیق کریں۔",
  } satisfies BilingualReason,
  unverifiedReason: {
    en: "Not enough could be checked against official records.",
    ur: "سرکاری ریکارڈ سے کافی جانچ نہیں ہو سکی۔",
  } satisfies BilingualReason,
  noProblemsReason: (n: number): BilingualReason => ({
    en: `No red flags in ${n} check${n === 1 ? "" : "s"}.`,
    ur: `${n} جانچوں میں کوئی خطرے کی علامت نہیں ملی۔`,
  }),
  /** Ends every medicine reply and result. */
  footer: {
    en: "Confirm with your pharmacist. Report fakes to DRAP.",
    ur: "اپنے فارماسسٹ سے تصدیق کریں۔ نقلی دوا کی اطلاع ڈریپ کو دیں۔",
  } satisfies BilingualReason,
  safety: {
    en: "This is a packaging and code check, not a lab test. If in doubt, ask your pharmacist or report to DRAP.",
    ur: "یہ پیکنگ اور کوڈ کی جانچ ہے، لیبارٹری ٹیسٹ نہیں۔ شک ہو تو اپنے فارماسسٹ سے پوچھیں یا ڈریپ کو اطلاع دیں۔",
  } satisfies BilingualReason,
};

// ─── Reference-image comparison (RAG vector-match follow-up) ──────────────────

const COMPARE_TIMEOUT_MS = 6000;
const DEFAULT_COMPARISON_REASON: BilingualReason = {
  en: "Reference image comparison unavailable — verdict based on standard pipeline.",
  ur: "حوالہ جاتی تصویر کا موازنہ دستیاب نہیں — فیصلہ معیاری طریقہ کار پر مبنی ہے۔",
};

async function fetchImageAsBase64(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) return null;

    const mimeType = res.headers.get("content-type") ?? "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());
    return { mimeType, data: buffer.toString("base64") };
  } catch (err) {
    console.warn(`[Translate] Failed to fetch image for comparison (${url}):`, err);
    return null;
  }
}

/**
 * Ask Gemini to compare a scanned product photo against the matched reference
 * image (found via vector similarity search — see lib/vectorSearch.ts) and
 * describe any visual discrepancies in one concise sentence: logo, font,
 * color, print quality, batch code format. Same "one sentence, factual, not
 * alarming" style as getDefaultReason().
 *
 * Requires both images to be fetched and base64-encoded as inline_data parts —
 * Gemini's file_data.file_uri only accepts URIs from its own Files API, not
 * arbitrary public URLs like Vercel Blob links.
 *
 * Never throws — falls back to a generic "comparison unavailable" string.
 */
export async function compareProductImages(
  scanImageUrl: string,
  referenceImageUrl: string,
  context: { product_name?: string | null; brand_name?: string | null } = {}
): Promise<BilingualReason> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return DEFAULT_COMPARISON_REASON;

  const [scanImage, referenceImage] = await Promise.all([
    fetchImageAsBase64(scanImageUrl),
    fetchImageAsBase64(referenceImageUrl),
  ]);

  if (!scanImage || !referenceImage) return DEFAULT_COMPARISON_REASON;

  try {
    const prompt = `You are a product authenticity assistant for ShelfWatch, an anti-counterfeit system for Pakistan's FMCG market.

The FIRST image is a photo just scanned by a user. The SECOND image is the verified reference/genuine product image for "${context.product_name ?? "this product"}" (brand: ${context.brand_name ?? "unknown"}), matched via image similarity search.

Compare the two images and note any visual discrepancies — logo, font, color, print quality, or batch code format. If they appear consistent, say so factually.

Write ONE concise sentence in BOTH English and Urdu. Be factual, not alarming.
Maximum 20 words per language. The Urdu must be natural Urdu script (not
transliteration) and convey the same meaning. Keep batch codes and numbers in
Latin digits in both languages.

Return ONE raw JSON object and nothing else — no markdown code fences, no commentary:
{"en": "...", "ur": "..."}`;

    const model = process.env.GEMINI_VISION_MODEL ?? "gemini-3.1-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), COMPARE_TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: scanImage.mimeType, data: scanImage.data } },
              { inline_data: { mime_type: referenceImage.mimeType, data: referenceImage.data } },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json" },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[Translate] Gemini vision comparison returned status ${response.status}`);
      return DEFAULT_COMPARISON_REASON;
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    return parseBilingualJson(text) ?? DEFAULT_COMPARISON_REASON;
  } catch (err) {
    console.error("[Translate] compareProductImages failed or timed out:", err);
    return DEFAULT_COMPARISON_REASON;
  }
}
