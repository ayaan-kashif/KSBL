/**
 * services/barcodeScanner.ts
 *
 * Extracts a barcode from a captured image. The ZXing decoder
 * (barcodeDecoder.ts) runs first and decodes the actual bar pattern; only if
 * it finds nothing does Gemini Vision try to READ the printed digits, which is
 * less reliable. The result records which of the two produced it, so callers
 * can trust a decoded barcode more than an AI-read one.
 */

import { decodeBarcode } from "./barcodeDecoder";
import { parseGs1, type Gs1Data } from "./gs1Parser";

/**
 *  decoded — ZXing decoded the symbol itself; the value is real data.
 *  ai_read — Gemini read the printed digits; checksum-validated, but a
 *            compensating misread is still possible.
 *  manual  — typed in by the user.
 */
export type BarcodeSource = "decoded" | "ai_read" | "manual";

export interface BarcodeRead {
  /** Raw payload — digits for retail codes, possibly a URL for a QR code. */
  value: string;
  /** ZXing format name ("EAN13", "QRCode"…), or null when not known. */
  format: string | null;
  source: BarcodeSource;
  checksumValid: boolean;
  /**
   * The product code to look up in the catalog / external databases, or null
   * when the payload isn't one (a plain URL or text in a QR/Code 128). Stray
   * digits in a URL would otherwise be read as a GS1 company prefix.
   */
  productCode: string | null;
  /**
   * GS1 element strings in the payload (DataMatrix / GS1 QR / GS1-128) —
   * GTIN, batch, expiry, serial. Null for a plain retail barcode or an AI read.
   */
  gs1: Gs1Data | null;
}

/**
 * Validates the EAN-13/UPC-A check digit (standard GS1 algorithm). A vision
 * model "reading" printed digits (rather than decoding the actual barcode
 * bar pattern) will occasionally misread a single digit — that produces a
 * number that looks plausible but fails checksum, which then wastes external
 * API lookups searching for a barcode that was never real. Formats other
 * than 12/13 digits (EAN-8, Code 128, etc.) aren't checked here and pass
 * through as-is.
 */
function isValidEanChecksum(digits: string): boolean {
  if (digits.length !== 12 && digits.length !== 13) return true;
  const padded = digits.length === 12 ? `0${digits}` : digits;
  const checkDigit = Number(padded[12]);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(padded[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const computed = (10 - (sum % 10)) % 10;
  return computed === checkDigit;
}

/**
 * Pull a GTIN out of a decoded payload. Retail and ITF codes are already bare
 * digits; QR / Data Matrix codes on packaging can carry a GS1 element string
 * ("(01)08901030873874…") or a GS1 Digital Link URL (".../01/08901030873874").
 * A GTIN-14 with a leading 0 is the GTIN-13 printed as EAN-13 — the form the
 * catalog stores.
 */
export function extractProductCode(text: string, gs1?: Gs1Data | null): string | null {
  const trimmed = text.trim();
  let gtin: string | null = null;

  if (/^\d{8,14}$/.test(trimmed)) {
    gtin = trimmed;
  } else if (gs1?.gtin) {
    gtin = gs1.gtin;
  } else {
    const elementString = trimmed.match(/^(?:\][A-Za-z]\d)?\(?01\)?(\d{14})/);
    const digitalLink = trimmed.match(/\/01\/(\d{14})(?:[/?#]|$)/);
    gtin = elementString?.[1] ?? digitalLink?.[1] ?? null;
  }

  if (gtin && gtin.length === 14 && gtin.startsWith("0")) gtin = gtin.slice(1);
  return gtin;
}

/** A barcode typed in by the user — looked up exactly as typed, as before. */
export function manualBarcodeRead(value: string): BarcodeRead {
  const trimmed = value.trim();
  // A pasted GS1 string ("(01)…(21)…") is still recognised as one.
  const gs1 = parseGs1(trimmed);
  return {
    value: trimmed,
    format: null,
    source: "manual",
    checksumValid: isValidEanChecksum(trimmed),
    productCode: trimmed,
    gs1: gs1.isGs1 ? gs1 : null,
  };
}

export async function scanBarcodeFromImage(
  imageBase64: string,
  mimeType = "image/jpeg"
): Promise<BarcodeRead | null> {
  const decoded = await decodeBarcode(Buffer.from(imageBase64, "base64"));
  if (decoded) {
    const gs1 = parseGs1(decoded.text, decoded.symbologyIdentifier);
    return {
      value: decoded.text,
      format: decoded.format,
      source: "decoded",
      checksumValid: decoded.checksumValid,
      productCode: extractProductCode(decoded.text, gs1),
      gs1: gs1.isGs1 ? gs1 : null,
    };
  }

  const aiDigits = await readBarcodeWithGemini(imageBase64, mimeType);
  if (!aiDigits) return null;
  return { value: aiDigits, format: null, source: "ai_read", checksumValid: true, productCode: aiDigits, gs1: null };
}

/** Structured decode result — see decodeBarcodeDetailed(). */
export interface DetailedBarcode {
  /** Raw payload as decoded. */
  raw: string;
  /** ZXing format name ("DataMatrix", "EAN13"…). */
  format: string | null;
  /** GTIN-13/14 or the digits of a retail code; null for a URL/text payload. */
  barcode: string | null;
  /** GS1 element strings, when the payload carries them. */
  gs1?: Gs1Data;
}

/** Hard ceiling on one detailed decode — a slow decode is dropped, never waited on. */
const DETAILED_DECODE_TIMEOUT_MS = 2000;

/**
 * ZXing decode only (no Gemini), returning the structured result. Used by the
 * medicine path for the back of the pack, where the DataMatrix usually sits.
 * scanBarcodeFromImage() above is unchanged and still what every scan uses
 * for its main barcode.
 *
 * Never throws: a WASM failure, a throw or the 2s timeout all return null, and
 * the caller keeps whatever it already had.
 */
export async function decodeBarcodeDetailed(imageBase64: string): Promise<DetailedBarcode | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const decoded = await Promise.race([
      decodeBarcode(Buffer.from(imageBase64, "base64")),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DETAILED_DECODE_TIMEOUT_MS);
      }),
    ]);
    if (!decoded) return null;
    const gs1 = parseGs1(decoded.text, decoded.symbologyIdentifier);
    return {
      raw: decoded.text,
      format: decoded.format,
      barcode: extractProductCode(decoded.text, gs1),
      ...(gs1.isGs1 ? { gs1 } : {}),
    };
  } catch (err) {
    console.warn("[Medicine] Detailed barcode decode failed:", err);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A detailed decode as the BarcodeRead the rest of the pipeline uses. */
export function detailedToBarcodeRead(d: DetailedBarcode): BarcodeRead {
  return {
    value: d.raw,
    format: d.format,
    source: "decoded",
    checksumValid: d.gs1 ? d.gs1.valid : d.barcode ? isValidEanChecksum(d.barcode) : true,
    productCode: d.barcode,
    gs1: d.gs1 ?? null,
  };
}

/** Fallback when ZXing finds nothing: ask Gemini to read the printed digits. */
async function readBarcodeWithGemini(
  imageBase64: string,
  mimeType: string
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[BarcodeScanner] GEMINI_API_KEY is not configured. Skipping scanning.");
    return null;
  }

  try {
    const prompt = `You are a professional barcode reader. Extract the numerical barcode (EAN-13, UPC-A, Code 128, etc.) visible in this product packaging image.
Return the digits of the barcode ONLY (e.g. 8901030873874).
If no barcode is visible, legible, or present, return 'null' only.
Do not output any other words, markdown, or text.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;

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
                inlineData: {
                  mimeType,
                  data: imageBase64,
                },
              },
              {
                text: prompt,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      console.warn(`[BarcodeScanner] Gemini returned status ${response.status}`);
      return null;
    }

    const data = await response.json();
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    console.log(`[BarcodeScanner] Gemini raw output: "${resultText}"`);

    if (!resultText || resultText.toLowerCase() === "null") {
      return null;
    }

    // Clean up any extra whitespace/characters
    const cleanDigits = resultText.replace(/\D/g, "");
    if (cleanDigits.length < 8) return null;

    if (!isValidEanChecksum(cleanDigits)) {
      console.warn(
        `[BarcodeScanner] Gemini read "${cleanDigits}" but it fails EAN/UPC checksum validation — ` +
        `likely a misread digit from the photo. Discarding rather than searching for a barcode that isn't real.`
      );
      return null;
    }

    return cleanDigits;
  } catch (err) {
    console.error("[BarcodeScanner] Failed to scan barcode from image:", err);
    return null;
  }
}
