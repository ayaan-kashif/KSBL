/**
 * lib/ocr.ts
 *
 * Thin wrapper around the Google Cloud Vision API for OCR.
 * Extracts batch number, manufacturing date, and MRP from a
 * product packaging image URL.
 *
 * Swap this file to use OCR.space or another provider without
 * touching any route logic.
 *
 * Required env vars:
 *   GOOGLE_VISION_API_KEY — Cloud Vision API key with Vision API enabled
 *
 * Fallback: returns nulls with raw = {} if the call fails or times out.
 */

export interface OcrResult {
  batch: string | null;
  mfg_date: string | null;
  mrp: string | null;
  raw: Record<string, unknown>;
}

// ─── Regex patterns for Pakistan FMCG packaging ─────────────────────────────

// Batch: letters-digits-letters or digits/letters combos like XP-992-KHI, HP-221-A
const BATCH_RE =
  /\b([A-Z]{1,4}[-/]?\d{2,6}[-/]?[A-Z]{0,5})\b/;

// Manufacturing date: MFG / Mfd / Date followed by date patterns
const MFG_DATE_RE =
  /(?:mfg\.?|mfd\.?|manufactured|date)[:\s]*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{2,4}[/-]\d{1,2}[/-]\d{1,2}|[A-Z][a-z]{2,8}\.?\s*\d{4})/i;

// MRP: Rs., PKR, MRP followed by digits
const MRP_RE =
  /(?:mrp|rs\.?|pkr)[:\s]*(\d{1,6}(?:\.\d{1,2})?)/i;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractFields(text: string): Omit<OcrResult, "raw"> {
  const batch = BATCH_RE.exec(text)?.[1] ?? null;
  const mfg_date = MFG_DATE_RE.exec(text)?.[1] ?? null;
  const mrp = MRP_RE.exec(text)?.[1] ?? null;
  return { batch, mfg_date, mrp };
}

// ─── Google Cloud Vision ──────────────────────────────────────────────────────

async function callGoogleVision(imageUrl: string): Promise<OcrResult> {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) {
    console.warn("[OCR] GOOGLE_VISION_API_KEY not set — returning null OCR result");
    return { batch: null, mfg_date: null, mrp: null, raw: {} };
  }

  const endpoint = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;

  const body = {
    requests: [
      {
        image: { source: { imageUri: imageUrl } },
        features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
      },
    ],
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Vision API error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as {
    responses: Array<{
      fullTextAnnotation?: { text: string };
      error?: { message: string };
    }>;
  };

  const response = data.responses[0];
  if (response?.error) {
    throw new Error(`Google Vision response error: ${response.error.message}`);
  }

  const fullText = response?.fullTextAnnotation?.text ?? "";
  const extracted = extractFields(fullText);

  return {
    ...extracted,
    raw: { fullText, annotationsCount: fullText.split("\n").length },
  };
}

// ─── OCR.space fallback ───────────────────────────────────────────────────────

async function callOcrSpace(imageUrl: string): Promise<OcrResult> {
  const apiKey = process.env.OCR_SPACE_API_KEY;
  if (!apiKey) {
    return { batch: null, mfg_date: null, mrp: null, raw: {} };
  }

  const formData = new FormData();
  formData.append("url", imageUrl);
  formData.append("language", "eng");
  formData.append("isOverlayRequired", "false");

  const res = await fetch("https://api.ocr.space/parse/imageurl", {
    method: "POST",
    headers: { apikey: apiKey },
    body: formData,
  });

  if (!res.ok) throw new Error(`OCR.space error ${res.status}`);

  const data = (await res.json()) as {
    ParsedResults?: Array<{ ParsedText: string }>;
  };

  const fullText = data.ParsedResults?.[0]?.ParsedText ?? "";
  const extracted = extractFields(fullText);

  return { ...extracted, raw: { fullText } };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run OCR on a publicly accessible image URL.
 * Tries Google Cloud Vision first; falls back to OCR.space if env key present.
 * Never throws — returns nulls on failure.
 */
export async function runOcr(imageUrl: string): Promise<OcrResult> {
  try {
    // Primary: Google Cloud Vision
    if (process.env.GOOGLE_VISION_API_KEY) {
      return await callGoogleVision(imageUrl);
    }
    // Fallback: OCR.space
    if (process.env.OCR_SPACE_API_KEY) {
      return await callOcrSpace(imageUrl);
    }
    console.warn("[OCR] No OCR API keys configured — returning null result");
    return { batch: null, mfg_date: null, mrp: null, raw: {} };
  } catch (err) {
    console.error("[OCR] Failed:", err);
    return { batch: null, mfg_date: null, mrp: null, raw: { error: String(err) } };
  }
}

// ─── Packaging text for medicine detection ────────────────────────────────────

// OCR.space answers in ~1s normally but sometimes takes well over 8s.
const PACKAGING_TEXT_TIMEOUT_MS = 15000;
/** OCR.space's free tier rejects images over 1 MB; phone photos are larger. */
const OCR_MAX_EDGE = 1600;

/**
 * Plain text read off one or more packaging photos (base64), for one job
 * only: deciding whether a scan is a medicine when the Gemini classification
 * didn't answer (see textLooksLikeMedicine in services/brandRouter.ts).
 *
 * Deliberately separate from runOcr(): runOcr's OCR.space call posts to an
 * endpoint that returns 404, so today it reads nothing — and its batch/MRP
 * output feeds the food verdict on WhatsApp. Repairing it would change food
 * results, so that stays a separate decision. This function uses the same
 * providers and keys, called correctly (Google Vision with inline content, or
 * OCR.space's POST /parse/image with base64Image).
 *
 * Images are read in parallel; never throws; returns null when nothing could
 * be read.
 */
export async function readPackagingText(
  images: { data: string | null; mimeType: string | null }[]
): Promise<string | null> {
  const usable = images.filter((img): img is { data: string; mimeType: string } => !!img.data && !!img.mimeType);
  if (!usable.length) return null;
  const texts = await Promise.all(usable.map((img) => readOne(img.data)));
  const joined = texts.filter(Boolean).join("\n").trim();
  return joined || null;
}

async function readOne(base64: string): Promise<string | null> {
  try {
    const { default: sharp } = await import("sharp");
    const jpeg = await sharp(Buffer.from(base64, "base64"))
      .rotate()
      .resize({ width: OCR_MAX_EDGE, height: OCR_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const content = jpeg.toString("base64");

    if (process.env.GOOGLE_VISION_API_KEY) {
      const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [{ image: { content }, features: [{ type: "TEXT_DETECTION", maxResults: 1 }] }] }),
        signal: AbortSignal.timeout(PACKAGING_TEXT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Google Vision ${res.status}`);
      const data = (await res.json()) as { responses?: Array<{ fullTextAnnotation?: { text: string } }> };
      return data.responses?.[0]?.fullTextAnnotation?.text ?? null;
    }

    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) return null;
    const form = new FormData();
    form.append("base64Image", `data:image/jpeg;base64,${content}`);
    form.append("language", "eng");
    form.append("OCREngine", "2");
    form.append("scale", "true");
    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: apiKey },
      body: form,
      signal: AbortSignal.timeout(PACKAGING_TEXT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`OCR.space ${res.status}`);
    const data = (await res.json()) as { IsErroredOnProcessing?: boolean; ParsedResults?: Array<{ ParsedText: string }> };
    if (data.IsErroredOnProcessing) throw new Error("OCR.space processing error");
    return data.ParsedResults?.[0]?.ParsedText ?? null;
  } catch (err) {
    console.warn("[OCR] readPackagingText failed:", err);
    return null;
  }
}
