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
 * One line per medicine check, fixed like GLOSSARY — only dates, codes and
 * counts are interpolated (in Latin digits in both languages).
 */
export const MEDICINE_CHECK_TEXT = {
  expiryValid: (date: string): BilingualReason => ({
    en: `Expiry ${date} — not expired ✓`,
    ur: `میعاد ${date} — ختم نہیں ہوئی ✓`,
  }),
  expiryExpired: (date: string): BilingualReason => ({
    en: `Expired on ${date} — do not use ✗`,
    ur: `میعاد ${date} کو ختم ہو چکی — استعمال نہ کریں ✗`,
  }),
  expiryUnknown: {
    en: "Expiry date not visible",
    ur: "میعاد کی تاریخ نظر نہیں آئی",
  } satisfies BilingualReason,
  codesMatch: {
    en: "Printed batch and expiry match the DataMatrix ✓",
    ur: "چھپا ہوا بیچ اور میعاد ڈیٹا میٹرکس سے مطابقت رکھتے ہیں ✓",
  } satisfies BilingualReason,
  codeMismatch: (field: "batch" | "expiry", printed: string, coded: string): BilingualReason => ({
    en: `Printed ${field} (${printed}) does not match the DataMatrix (${coded}) ✗`,
    ur: `چھپی ہوئی ${field === "batch" ? "بیچ" : "میعاد"} (${printed}) ڈیٹا میٹرکس (${coded}) سے مطابقت نہیں رکھتی ✗`,
  }),
  codeUnsure: (printed: string, coded: string): BilingualReason => ({
    en: `Printed batch (${printed}) differs from the DataMatrix (${coded}) by one character — possibly a misread; check by eye`,
    ur: `چھپا ہوا بیچ (${printed}) ڈیٹا میٹرکس (${coded}) سے ایک حرف مختلف ہے — شاید غلط پڑھا گیا؛ خود دیکھ کر تصدیق کریں`,
  }),
  gtinInvalid: {
    en: "The DataMatrix product code (GTIN) is invalid ✗",
    ur: "ڈیٹا میٹرکس کا پروڈکٹ کوڈ (GTIN) درست نہیں ✗",
  } satisfies BilingualReason,
  codesNotChecked: {
    en: "Code consistency not checked — no DataMatrix, or nothing printed to compare",
    ur: "کوڈ کی مطابقت نہیں جانچی گئی — ڈیٹا میٹرکس نہیں یا موازنے کے لیے کچھ چھپا ہوا نہیں",
  } satisfies BilingualReason,
  serialOk: (scans: number): BilingualReason => ({
    en: `Serial number seen ${scans} time(s) — no sign of a copied code ✓`,
    ur: `یہ سیریل نمبر ${scans} بار اسکین ہوا — نقل شدہ کوڈ کی کوئی علامت نہیں ✓`,
  }),
  // Names only what tripped the check: anonymous scans add areas but no people.
  serialDuplicateAreas: (areas: number): BilingualReason => ({
    en: `This serial number has already been scanned in ${areas} different areas — possible copied code ✗`,
    ur: `یہ سیریل نمبر ${areas} مختلف علاقوں میں اسکین ہو چکا ہے — ممکنہ نقل شدہ کوڈ ✗`,
  }),
  serialDuplicatePeople: (reporters: number): BilingualReason => ({
    en: `This serial number has already been scanned by ${reporters} different people — possible copied code ✗`,
    ur: `یہ سیریل نمبر ${reporters} مختلف افراد اسکین کر چکے ہیں — ممکنہ نقل شدہ کوڈ ✗`,
  }),
  identityMatched: (name: string, company: string): BilingualReason => ({
    en: `Matched to ${name} (${company}) in the medicine catalogue ✓`,
    ur: `دواؤں کے کیٹلاگ میں ${name} (${company}) سے مطابقت ملی ✓`,
  }),
  identityNotFound: {
    en: "Not in our medicine catalogue yet — this alone doesn't mean it's fake",
    ur: "یہ دوا ابھی ہمارے کیٹلاگ میں نہیں — صرف اس سے یہ جعلی ثابت نہیں ہوتی",
  } satisfies BilingualReason,
  registrationFound: (regNo: string, name: string, company: string | null): BilingualReason => ({
    en: `DRAP Reg. No. ${regNo} is listed for ${name}${company ? ` (${company})` : ""} ✓`,
    ur: `ڈریپ رجسٹریشن نمبر ${regNo} ${name}${company ? ` (${company})` : ""} کے لیے درج ہے ✓`,
  }),
  registrationMismatch: (regNo: string, name: string, company: string | null): BilingualReason => ({
    en: `DRAP Reg. No. ${regNo} belongs to ${name}${company ? ` (${company})` : ""}, not to this product ✗`,
    ur: `ڈریپ رجسٹریشن نمبر ${regNo} ${name}${company ? ` (${company})` : ""} کا ہے، اس مصنوع کا نہیں ✗`,
  }),
  registrationNotFound: (regNo: string): BilingualReason => ({
    en: `DRAP Reg. No. ${regNo} was not found in DRAP's registry ✗`,
    ur: `ڈریپ رجسٹریشن نمبر ${regNo} ڈریپ کے ریکارڈ میں نہیں ملا ✗`,
  }),
  registrationNotInPriceList: (regNo: string): BilingualReason => ({
    en: `DRAP Reg. No. ${regNo} isn't in DRAP's public price list, which doesn't cover every medicine — not checked`,
    ur: `ڈریپ رجسٹریشن نمبر ${regNo} ڈریپ کی عوامی قیمتوں کی فہرست میں نہیں، جس میں ہر دوا شامل نہیں — جانچ نہیں ہو سکی`,
  }),
  registrationUnavailable: {
    en: "DRAP registration: not checked — source unavailable",
    ur: "ڈریپ رجسٹریشن: جانچ نہیں ہو سکی — ذریعہ دستیاب نہیں",
  } satisfies BilingualReason,
  registrationNotVisible: {
    en: "DRAP registration number not visible — not checked",
    ur: "ڈریپ رجسٹریشن نمبر نظر نہیں آیا — جانچ نہیں ہو سکی",
  } satisfies BilingualReason,
  gtinPrefixMismatch: (owner: string, company: string): BilingualReason => ({
    en: `The product code belongs to ${owner}, but the pack says ${company} ✗`,
    ur: `پروڈکٹ کوڈ ${owner} کا ہے، مگر پیک پر ${company} لکھا ہے ✗`,
  }),
  packagingOk: {
    en: "Packaging consistent with the official reference image ✓",
    ur: "پیکنگ سرکاری حوالہ جاتی تصویر کے مطابق ہے ✓",
  } satisfies BilingualReason,
  packagingMismatch: {
    en: "Packaging differs from the official reference (logo, name, layout or print) ✗",
    ur: "پیکنگ سرکاری حوالے سے مختلف ہے (لوگو، نام، ترتیب یا چھپائی) ✗",
  } satisfies BilingualReason,
  packagingTampered: {
    en: "Packaging shows signs of tampering ✗",
    ur: "پیکنگ میں چھیڑ چھاڑ کے آثار ہیں ✗",
  } satisfies BilingualReason,
  packagingNoReference: {
    en: "No official reference image to compare the packaging against",
    ur: "پیکنگ کے موازنے کے لیے کوئی سرکاری حوالہ جاتی تصویر نہیں",
  } satisfies BilingualReason,
  packagingUnavailable: {
    en: "Packaging inspection unavailable right now",
    ur: "پیکنگ کی جانچ اس وقت دستیاب نہیں",
  } satisfies BilingualReason,
  serialMissing: {
    en: "No serial number on the code — duplicate check not possible",
    ur: "کوڈ پر سیریل نمبر نہیں — ڈپلیکیٹ کی جانچ ممکن نہیں",
  } satisfies BilingualReason,
  serialUnavailable: {
    en: "Duplicate-serial check unavailable right now",
    ur: "ڈپلیکیٹ سیریل کی جانچ اس وقت دستیاب نہیں",
  } satisfies BilingualReason,
};

/**
 * Medicine verdict copy. A medicine is never called "genuine", "verified" or
 * "100% original": without DRAP's official serial verification the most this
 * app can honestly say is that it found no problems. Mirrored client-side in
 * lib/verdictCopy.ts (MEDICINE_COPY) — keep the two in sync.
 */
export const MEDICINE_VERDICT_TEXT = {
  noProblems: {
    en: "No problems found — official DRAP verification pending",
    ur: "کوئی مسئلہ نہیں ملا — ڈریپ کی سرکاری تصدیق زیر التوا",
  } satisfies BilingualReason,
  suspicious: {
    en: "⚠️ Suspicious medicine — problems were found with this pack. Do not use it until a pharmacist has checked it.",
    ur: "⚠️ مشکوک دوا — اس پیک میں مسائل پائے گئے۔ فارماسسٹ کی جانچ تک استعمال نہ کریں۔",
  } satisfies BilingualReason,
  unverified: {
    en: "❓ Not enough could be checked — finding no problem is not the same as confirming this medicine",
    ur: "❓ کافی جانچ ممکن نہیں ہو سکی — مسئلہ نہ ملنے کا مطلب دوا کی تصدیق نہیں",
  } satisfies BilingualReason,
  unverifiedReason: {
    en: "Too few checks could be completed against official references (catalogue or DRAP registration) to judge this medicine.",
    ur: "سرکاری حوالوں (کیٹلاگ یا ڈریپ رجسٹریشن) سے اتنی جانچ نہیں ہو سکی کہ اس دوا کے بارے میں فیصلہ کیا جا سکے۔",
  } satisfies BilingualReason,
  expired: {
    en: "Expired — do not use",
    ur: "میعاد ختم — استعمال نہ کریں",
  } satisfies BilingualReason,
  safety: {
    en: "This is a packaging and code check, not a lab test. If in doubt, ask your pharmacist or report to DRAP.",
    ur: "یہ پیکنگ اور کوڈ کی جانچ ہے، لیبارٹری ٹیسٹ نہیں۔ شک ہو تو اپنے فارماسسٹ سے پوچھیں یا ڈریپ کو اطلاع دیں۔",
  } satisfies BilingualReason,
  moreProblems: (n: number): BilingualReason => ({
    en: ` (and ${n} more problem${n === 1 ? "" : "s"})`,
    ur: ` (اور مزید ${n} مسائل)`,
  }),
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
