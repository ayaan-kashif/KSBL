/**
 * services/barcodeDecoder.ts
 *
 * Decodes a barcode from the actual bar/module pattern in a photo, using
 * ZXing-C++ compiled to WebAssembly (zxing-wasm). Unlike the Gemini path in
 * barcodeScanner.ts, which READS the printed digits and can misread one, a
 * ZXing decode is only returned when the symbol itself decodes — for EAN/UPC
 * that includes the check digit — so its output is real data, not inference.
 *
 * Runs server-side only. Two passes:
 *   1. EXIF auto-rotate, then decode as-is.
 *   2. Only if pass 1 found nothing: grayscale + upscale + normalise/sharpen,
 *      which recovers small or low-contrast barcodes from phone photos.
 *
 * WASM loading: by default zxing-wasm FETCHES its .wasm from the jsDelivr CDN
 * at runtime, which is both a hidden network dependency and a failure mode on
 * a server. The binary is read from node_modules instead and handed over via
 * `wasmBinary`. next.config.ts keeps zxing-wasm out of the server bundle
 * (serverExternalPackages) and ships the .wasm file with every route that
 * decodes (outputFileTracingIncludes), so the same path resolves on Vercel.
 *
 * Never throws — logs and returns null on any failure, so callers fall back to
 * the Gemini read exactly as before this decoder existed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { prepareZXingModule, readBarcodes, type ReaderOptions, type ReadResult } from "zxing-wasm/reader";

export interface DecodedBarcode {
  text: string;
  /** ZXing format name, e.g. "EAN13", "Code128", "QRCode". */
  format: string;
  checksumValid: boolean;
  /** ISO/IEC 15424 identifier, e.g. "]d2" = GS1 DataMatrix, "]Q3" = GS1 QR, "]C1" = GS1-128. */
  symbologyIdentifier: string | null;
}

const FORMATS: ReaderOptions["formats"] = [
  "EAN13",
  "EAN8",
  "UPCA",
  "UPCE",
  "Code128",
  "Code39",
  "ITF",
  "QRCode",
  "DataMatrix",
];

/** Retail product codes — preferred when one photo yields several symbols. */
const RETAIL_FORMATS = new Set(["EAN13", "EAN8", "UPCA", "UPCE"]);

const READER_OPTIONS: ReaderOptions = {
  formats: FORMATS,
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 4,
};

/** Long-edge bounds for the decode passes. Phone photos are ~4000px, and a
 *  48MB RGBA buffer is slow to scan for no gain; WhatsApp-compressed or
 *  cropped photos can be a few hundred px, too small for thin bars. */
const PASS1_MAX_EDGE = 2000;
const PASS2_MIN_EDGE = 1600;
const PASS2_MAX_EDGE = 2400;

let moduleReady = false;

function ensureZXingModule(): boolean {
  if (moduleReady) return true;
  try {
    const wasmPath = path.join(process.cwd(), "node_modules", "zxing-wasm", "dist", "reader", "zxing_reader.wasm");
    const bytes = readFileSync(wasmPath);
    prepareZXingModule({
      overrides: {
        wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      },
    });
    moduleReady = true;
    return true;
  } catch (err) {
    console.error("[BarcodeDecoder] Could not load zxing_reader.wasm:", err);
    return false;
  }
}

/**
 * GS1 mod-10 check digit (EAN-8, UPC-A, EAN-13, GTIN-14): weights 3,1,3,1…
 * counted from the digit left of the check digit.
 */
export function isValidGs1CheckDigit(digits: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const fromRight = body.length - 1 - i;
    sum += Number(body[i]) * (fromRight % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

function checksumValidFor(result: ReadResult): boolean {
  // UPC-E carries its check digit over the EXPANDED UPC-A, so the plain mod-10
  // on its 8 digits doesn't apply — ZXing has already verified it.
  if (RETAIL_FORMATS.has(result.format) && result.format !== "UPCE") {
    return isValidGs1CheckDigit(result.text);
  }
  return result.isValid;
}

/** sharp raw output (1–4 channels) → the RGBA ImageData shape ZXing expects. */
async function toImageData(img: sharp.Sharp): Promise<ImageData> {
  const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const r = data[j];
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = channels >= 3 ? data[j + 1] : r;
    rgba[i * 4 + 2] = channels >= 3 ? data[j + 2] : r;
    rgba[i * 4 + 3] = 255;
  }
  // zxing-wasm duck-types ImageData; Node has no DOM constructor for it.
  return { data: rgba, width, height, colorSpace: "srgb" } as ImageData;
}

function pickBest(results: ReadResult[]): ReadResult | null {
  const valid = results.filter((r) => r.isValid && r.text);
  return valid.find((r) => RETAIL_FORMATS.has(r.format)) ?? valid[0] ?? null;
}

async function decodePass(image: ImageData, pass: string): Promise<ReadResult | null> {
  const results = await readBarcodes(image, READER_OPTIONS);
  const best = pickBest(results);
  if (best) console.log(`[BarcodeDecoder] ${pass}: ${best.format} "${best.text}"`);
  return best;
}

export async function decodeBarcode(bytes: Buffer | Uint8Array): Promise<DecodedBarcode | null> {
  if (!ensureZXingModule()) return null;

  try {
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // .rotate() with no argument applies the EXIF orientation — phone photos
    // are usually stored sideways with an orientation tag.
    const oriented = await sharp(input).rotate().toBuffer();

    let result = await decodePass(
      await toImageData(
        sharp(oriented).resize({ width: PASS1_MAX_EDGE, height: PASS1_MAX_EDGE, fit: "inside", withoutEnlargement: true })
      ),
      "pass 1"
    );

    if (!result) {
      const meta = await sharp(oriented).metadata();
      const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
      const target = Math.min(PASS2_MAX_EDGE, Math.max(PASS2_MIN_EDGE, longEdge));
      result = await decodePass(
        await toImageData(
          sharp(oriented)
            .grayscale()
            .resize({ width: target, height: target, fit: "inside" })
            .normalise()
            .sharpen()
        ),
        "pass 2 (preprocessed)"
      );
    }

    if (!result) return null;
    return {
      text: result.text,
      format: result.format,
      checksumValid: checksumValidFor(result),
      symbologyIdentifier: result.symbologyIdentifier || null,
    };
  } catch (err) {
    console.error("[BarcodeDecoder] Decode failed:", err);
    return null;
  }
}
