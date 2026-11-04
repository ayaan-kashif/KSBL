/**
 * services/geminiVision.ts
 *
 * Compares user captured image and database reference data/image using Gemini 2.5 Flash.
 */

import { UnifiedProduct } from "./cacheService";

export interface GeminiComparisonResult {
  logoMatch: number;
  packagingMatch: number;
  barcodeMatch: number;
  brandMatch: number;
  designMatch: number;
  tampering: boolean;
  confidence: number;
  reason: string;
  /** Urdu rendering of `reason`. Produced by this same call rather than a
   *  follow-up translation request — the scan is already multi-second, and a
   *  second round-trip just to translate one sentence would be felt. */
  reasonUr: string;
  /** Text transcribed off a medicine pack — only when asked for (medicine
   *  path), in the same call. Null fields were not clearly visible. */
  printed?: MedicinePrinted | null;
}

/** Fields printed on a medicine pack. Never inferred: null = not visible. */
export interface MedicinePrinted {
  brandName: string | null;
  genericName: string | null;
  strength: string | null;
  dosageForm: string | null;
  packSize: string | null;
  manufacturer: string | null;
  drapRegNo: string | null;
  batch: string | null;
  mfgDate: string | null;
  expiryDate: string | null;
  mrp: string | null;
}

const MEDICINE_PRINTED_KEYS: (keyof MedicinePrinted)[] = [
  "brandName", "genericName", "strength", "dosageForm", "packSize", "manufacturer",
  "drapRegNo", "batch", "mfgDate", "expiryDate", "mrp",
];

/** Keep only real transcriptions: the model's "not visible" spellings become null. */
function parseMedicinePrinted(value: unknown): MedicinePrinted | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const printed = {} as MedicinePrinted;
  for (const key of MEDICINE_PRINTED_KEYS) {
    const raw = typeof source[key] === "string" ? (source[key] as string).trim() : "";
    printed[key] = !raw || /^(null|n\/?a|none|not visible|unknown|-)$/i.test(raw) ? null : raw;
  }
  return printed;
}

const DEFAULT_FALLBACK_RESULT: GeminiComparisonResult = {
  logoMatch: 50,
  packagingMatch: 50,
  barcodeMatch: 50,
  brandMatch: 50,
  designMatch: 50,
  tampering: false,
  confidence: 40,
  reason: "Failed to verify packaging visual details securely. Falling back to safe default analysis.",
  reasonUr: "پیکنگ کی ظاہری تفصیلات کی محفوظ تصدیق نہیں ہو سکی۔ معیاری تجزیے پر انحصار کیا جا رہا ہے۔",
};

export type ProductCategory = "medicine" | "food" | "other";

/** True when the comparison call failed and returned the safe default
 *  instead of a real inspection — its scores are not evidence either way. */
export function isGeminiFallback(result: GeminiComparisonResult): boolean {
  return result === DEFAULT_FALLBACK_RESULT;
}

export interface BrandDetection {
  brand: string;
  confidence: number; // 0–1
  /** What kind of product the pack is — routes medicines to their own path.
   *  Read in this same call so classification adds no extra round-trip. */
  category: ProductCategory | null;
}

/** Wordmark/category call budget: the first attempt, and one retry. */
const WORDMARK_TIMEOUT_MS = 10000;
const WORDMARK_RETRY_TIMEOUT_MS = 6000;
/** Transient Gemini failures worth one retry ("high demand" is a 503). */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Read the brand wordmark off a packaging photo. Deliberately narrow: no
 * comparison, no scoring, no authenticity judgement — it exists only so
 * brandRouter can decide WHICH verification path a scan belongs on, before
 * any of the heavy work runs.
 *
 * Its answer routes the whole scan — a medicine with no DataMatrix is only
 * recognised here — so it gets WORDMARK_TIMEOUT_MS and one quick retry on a
 * transient failure (a 4s ceiling used to drop it whenever Gemini was slow,
 * sending medicines down the food path).
 *
 * Never throws — returns null on any failure so the router falls through to
 * its "unknown" branch and defaults to the external path.
 */
export async function detectBrandFromImage(
  imageBase64: string,
  mimeType = "image/jpeg",
  /** Optional back/label photo, used for the category only: "Reg. No.", "Rx"
   *  and the strength usually sit on the back of a medicine pack. */
  backImage?: { data: string | null; mimeType: string | null }
): Promise<BrandDetection | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  // TRANSCRIBE, do not identify. Asked to "identify the brand", the model
  // silently normalises a misspelled wordmark to the famous brand it resembles
  // — a pack printed "Nationel" came back as "National" — which destroys the
  // single strongest counterfeit signal we have before it reaches
  // classifyWordmark(). Naming correctly-spelled brands as examples made it
  // worse by priming the canonical spellings.
  const prompt = `Transcribe the manufacturer/brand wordmark printed on this product packaging, letter by letter, exactly as it appears.

This is an OCR task, NOT a recognition task.

Rules:
- Copy the characters you actually see. Do NOT correct spelling, do NOT
  normalise to a brand you recognise, do NOT expand abbreviations.
- Counterfeit packaging often misspells the brand by one or two letters. If the
  pack reads "Nationel", "Natlonal" or "Adibas", you must report exactly that —
  reporting the correctly-spelled brand instead would be an error.
- Read only the largest brand wordmark, usually in the logo. Ignore product
  names, flavours, taglines and legal text.
- Preserve the spelling but not the styling: report "National Foods", not
  "NATIONAL FOODS", unless the letters themselves differ.
- Do NOT judge authenticity or quality. Wordmark only.
- If no wordmark is legible, return {"brand": "", "confidence": 0}.
- confidence is how clearly you could READ the characters, 0.0 to 1.0 — not how
  confident you are about which company it is.

Separately, classify the item in "category" (this does not change the brand rules above):
- "medicine": a pharmaceutical product — tablets, capsules, syrup, suspension,
  drops, injection, inhaler, or a cream/ointment sold as a drug — or a pack
  showing a drug registration number ("Reg. No."), "DRAP", "Rx", or a strength
  such as "500 mg" next to a dosage form.
- "food": food, drinks, sauces, spices, condiments.
- "other": anything else (detergent, soap, cosmetics, household goods).

Return ONE raw JSON object and nothing else — no markdown code fences, no commentary:
{"brand": "...", "confidence": 0.0, "category": "food"}`;

  const hasBack = !!(backImage?.data && backImage?.mimeType);
  const fullPrompt = hasBack
    ? `${prompt}

A second photo shows the BACK of the same pack. Transcribe the wordmark from the FIRST photo only; use both photos to decide "category".`
    : prompt;

  try {
    const model = process.env.GEMINI_VISION_MODEL ?? "gemini-3.1-flash-lite";
    const body = JSON.stringify({
      contents: [
        {
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            ...(hasBack ? [{ inlineData: { mimeType: backImage!.mimeType!, data: backImage!.data! } }] : []),
            { text: fullPrompt },
          ],
        },
      ],
      // temperature 0: transcription has one right answer, and a verdict
      // that flips between runs on the same photo is not demonstrable.
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    });

    let res: Response | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(attempt === 1 ? WORDMARK_TIMEOUT_MS : WORDMARK_RETRY_TIMEOUT_MS),
        });
      } catch (err) {
        // A timeout means Gemini is slow, not refusing: retrying would only
        // double the wait. A dropped connection is worth one more try.
        if ((err as Error)?.name === "TimeoutError" || attempt === 2) throw err;
        console.warn("[GeminiVision] detectBrandFromImage connection failed — retrying once");
        continue;
      }
      if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt === 2) break;
      console.warn(`[GeminiVision] detectBrandFromImage returned ${res.status} — retrying once`);
    }

    if (!res) return null;
    if (!res.ok) {
      console.warn(`[GeminiVision] detectBrandFromImage returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    let text: string = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    if (!text) return null;

    // Defensive parse — same treatment as the other JSON-returning calls here:
    // strip fences, then take the outermost braces in case of stray prose.
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    }
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last > first) text = text.slice(first, last + 1);

    const parsed = JSON.parse(text);
    const brand = typeof parsed?.brand === "string" ? parsed.brand.trim() : "";
    const category: ProductCategory | null =
      parsed?.category === "medicine" || parsed?.category === "food" || parsed?.category === "other"
        ? parsed.category
        : null;
    // An illegible wordmark returns null as before — except on a medicine,
    // where the category alone is still needed to route the scan.
    if (!brand && category !== "medicine") return null;

    const raw = Number(parsed?.confidence);
    const confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
    return { brand, confidence, category };
  } catch (err) {
    console.error("[GeminiVision] detectBrandFromImage failed:", err);
    return null;
  }
}

// Helper to download an image from a URL and convert it to a base64 string
async function fetchImageBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  if (!url || !url.startsWith("http")) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3 seconds timeout

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = res.headers.get("content-type") || "image/jpeg";
    return {
      data: buffer.toString("base64"),
      mimeType,
    };
  } catch (err) {
    console.warn(`[GeminiVision] Failed to fetch reference image base64 from ${url}:`, err);
    return null;
  }
}

export async function compareImagesWithGemini(
  capturedImageBase64: string,
  productInfo: UnifiedProduct | null,
  capturedMimeType = "image/jpeg",
  /** Optional second (back/label) photo of the same product — improves
   * accuracy since barcodes, batch codes, and ingredient lists are commonly
   * printed on the back panel rather than the front-facing brand side. */
  backImage?: { data: string | null; mimeType: string | null },
  /** Barcode ZXing decoded from the pack (barcodeDecoder.ts), if any — real
   * data, so Gemini compares it instead of reading the digits itself. */
  decodedBarcode?: string | null,
  /** medicine: also transcribe the pack's printed fields into `printed`. */
  options: { medicine?: boolean } = {}
): Promise<GeminiComparisonResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[GeminiVision] GEMINI_API_KEY is not configured. Returning fallback.");
    return DEFAULT_FALLBACK_RESULT;
  }

  try {
    console.log("[GeminiVision] Starting Gemini visual comparison...");

    // Gather reference info
    const productName = productInfo?.name || "Unknown Product";
    const productBrand = productInfo?.brand || "Unknown Brand";
    const productManufacturer = productInfo?.manufacturer || "Unknown Manufacturer";
    const productCategory = productInfo?.category || "Unknown Category";
    const productBarcode = productInfo?.barcode || "Unknown Barcode";
    const productSize = productInfo?.size || "Unknown Size";
    const referenceImageURL = productInfo?.referenceImage || "";

    // Download the reference image if it exists to pass it to Gemini side-by-side
    const referenceImage = await fetchImageBase64(referenceImageURL);
    const hasBackImage = !!(backImage?.data && backImage?.mimeType);

    // Build the query prompt
    const prompt = `You are a product authenticity inspection expert. Your job is to compare a user's captured product photo (or photos) with official product reference details.

Official Reference Details:
- Name: ${productName}
- Brand: ${productBrand}
- Manufacturer: ${productManufacturer}
- Category: ${productCategory}
- Barcode: ${productBarcode}
- Size/Weight: ${productSize}

${hasBackImage
  ? `You have been given TWO photos of the same physical product: the FRONT (brand-facing side) and the BACK (label side, which typically shows the barcode, batch code, ingredients/nutrition panel, and expiry date). Use both together as one combined assessment — for example, a barcode or batch code that's illegible or missing on the front may still be visible and checkable on the back.`
  : `You have been given ONE photo of the product (its front, brand-facing side). No back/label photo was provided, so do not penalize the product for details that are only normally visible on a back label (e.g. don't assume a missing barcode means counterfeit if it's simply not shown in this photo) — assess only what is visible.`}

Inspect the captured image(s) and evaluate the following:
1. Logo Match: Check if the logo matches the official brand design (shapes, colors, details).
2. Packaging Match: Check if the packaging colors, warnings, fonts, and materials match.
3. Barcode Match: Check if the barcode visible in either photo matches the reference barcode (${productBarcode}).${decodedBarcode
  ? ` The barcode on the pack was machine-decoded as ${decodedBarcode}; use that value instead of reading the printed digits yourself.`
  : ""}
4. Brand Match: Check if the brand name and trademarks are spelled correctly and placed accurately.
5. Design Match: Check if print alignments, labels, seals, and overall packaging design elements are correct.
6. Tampering: Look for signs of tampering, broken seals, cuts, or fake glue, on either photo.
7. Expiry & Print Quality: Assess whether the print quality is sharp/legible or blurry/low-quality (a common sign of counterfeit).

Respond with a raw JSON object ONLY. Do not wrap the JSON in markdown code blocks (like \`\`\`json ... \`\`\`), do not output any extra comments or text.

Required JSON Structure:
{
  "logoMatch": 95,
  "packagingMatch": 91,
  "barcodeMatch": 100,
  "brandMatch": 100,
  "designMatch": 89,
  "tampering": false,
  "confidence": 94,
  "reason": "Write a concise explanation of the verdict, highlighting any typography or printing anomalies.",
  "reasonUr": "The SAME explanation written in natural Urdu script."
}

"reasonUr" must be natural Urdu script (not Latin transliteration) and must
convey the same meaning as "reason". Keep batch codes, barcodes, dates and
numbers in Latin digits inside the Urdu sentence.

Check the brand wordmark character by character before scoring "brandMatch".
Counterfeits routinely misspell the brand by one or two letters ("Nationel" for
"National", "Adibas" for "Adidas") while reproducing the logo shape, colours and
typeface faithfully. A misspelled wordmark is conclusive evidence of a
counterfeit: score "brandMatch" at or near 0 whenever the printed spelling
differs from the real brand, no matter how clean the printing is, and say so in
"reason".

Note: If no official reference data/image is available (unregistered product),
score against generic industry standards for authentic packaging based purely on
what you observe. Print quality is evidence, but do not treat it as proof: a
counterfeit produced on good equipment is sharp, clean and untampered, so
"sharp printing" alone must not produce high match scores. Every *Match score
answers "does this match the genuine article", not "is this well printed" — if
you have nothing to compare against, you cannot score a match highly, and
"confidence" should reflect that uncertainty rather than your impression of the
print.

Normalise all numeric scores to a scale of 0 to 100.${options.medicine ? `

This item is a MEDICINE. Also add a "printed" object to the JSON, transcribing
what is printed on the pack (either photo). Copy the characters exactly as
printed. Use null for anything not clearly legible. NEVER guess, infer or fill
in a value from your own knowledge of the product — a wrong batch or expiry is
worse than a missing one.
"printed": {
  "brandName": "...", "genericName": "...", "strength": "e.g. 500 mg",
  "dosageForm": "e.g. Tablet", "packSize": "e.g. 10 x 10", "manufacturer": "...",
  "drapRegNo": "registration number only, e.g. 012345", "batch": "...",
  "mfgDate": "as printed", "expiryDate": "as printed", "mrp": "as printed"
}` : ""}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;

    // Prepare content parts. Gemini accepts either an inline blob or a text
    // block per part, so the union is the accurate type rather than `any`.
    type GeminiPart =
      | { inlineData: { mimeType: string; data: string } }
      | { text: string };
    const parts: GeminiPart[] = [];

    // Add captured front image
    parts.push({
      inlineData: {
        mimeType: capturedMimeType,
        data: capturedImageBase64,
      },
    });

    // Add captured back/label image, if provided
    if (hasBackImage) {
      parts.push({
        inlineData: {
          mimeType: backImage!.mimeType!,
          data: backImage!.data!,
        },
      });
    }

    // Add reference image side-by-side if successfully downloaded
    if (referenceImage) {
      console.log("[GeminiVision] Reference image downloaded successfully. Passing side-by-side.");
      parts.push({
        inlineData: {
          mimeType: referenceImage.mimeType,
          data: referenceImage.data,
        },
      });
    }

    // Add prompt text
    parts.push({
      text: prompt,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts,
          },
        ],
        // Force JSON response if possible
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
    });

    if (!response.ok) {
      console.warn(`[GeminiVision] API returned status ${response.status}`);
      return DEFAULT_FALLBACK_RESULT;
    }

    const responseData = await response.json();
    const responseText = responseData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    console.log("[GeminiVision] Raw analysis response received.");

    // Parse the JSON securely
    let cleanJsonStr = responseText;
    // Strip markdown code block wrappers if Gemini ignored the prompt instruction
    if (cleanJsonStr.startsWith("```")) {
      cleanJsonStr = cleanJsonStr.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    }
    // The model sometimes trails a stray "``" after a valid object, which
    // throws the whole answer away. Medicine scans take the outermost braces,
    // as detectBrandFromImage does. Not yet applied to food scans: it would
    // change their scores, so it waits for an explicit go-ahead.
    if (options.medicine) {
      const first = cleanJsonStr.indexOf("{");
      const last = cleanJsonStr.lastIndexOf("}");
      if (first !== -1 && last > first) cleanJsonStr = cleanJsonStr.slice(first, last + 1);
    }

    try {
      const parsed = JSON.parse(cleanJsonStr);
      // A decoded barcode equal to the reference is a fact, not an opinion.
      // A difference is left to Gemini: scraped catalog SKUs are often not
      // real barcodes, so "not equal" proves nothing on its own.
      const decodedMatchesReference =
        !!decodedBarcode && !!productInfo?.barcode && decodedBarcode.trim() === productInfo.barcode.trim();
      // Validate structure and map fields
      return {
        logoMatch: Number(parsed.logoMatch) ?? 50,
        packagingMatch: Number(parsed.packagingMatch) ?? 50,
        barcodeMatch: decodedMatchesReference ? 100 : Number(parsed.barcodeMatch) ?? 50,
        brandMatch: Number(parsed.brandMatch) ?? 50,
        designMatch: Number(parsed.designMatch) ?? 50,
        tampering: Boolean(parsed.tampering) ?? false,
        confidence: Number(parsed.confidence) ?? 50,
        reason: parsed.reason || "Verification completed.",
        // Fall back to the fixed Urdu string rather than echoing the English
        // one — an English sentence in the Urdu slot reads as a bug on screen.
        reasonUr:
          typeof parsed.reasonUr === "string" && parsed.reasonUr.trim()
            ? parsed.reasonUr.trim()
            : "تصدیق مکمل ہو گئی۔",
        ...(options.medicine ? { printed: parseMedicinePrinted(parsed.printed) } : {}),
      };
    } catch (parseErr) {
      console.error("[GeminiVision] Failed to parse response text as JSON:", cleanJsonStr, parseErr);
      return DEFAULT_FALLBACK_RESULT;
    }
  } catch (err) {
    console.error("[GeminiVision] Failed to execute visual comparison:", err);
    return DEFAULT_FALLBACK_RESULT;
  }
}
