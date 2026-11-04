/**
 * services/barcodeEvidence.ts
 *
 * Turns a barcode read into evidence for the EXISTING verdict logic of both
 * pipelines (/api/verify's verificationPaths.ts and lib/verifyProduct.ts). It
 * adds no scoring of its own — callers feed the result into the checks they
 * already run.
 *
 * Rules:
 *  - No barcode                → neutral, exactly as before.
 *  - Matches identified product → positive.
 *  - Read but not on record     → neutral. National Foods catalog rows are
 *    scraped and often carry no real barcode, so "not found" must never count
 *    against a product.
 *  - Mismatch                   → counterfeit signal, but ONLY when a ZXing-
 *    decoded barcode resolves to a different company than the one the
 *    packaging identifies. Judged on the National Foods dimension only (the
 *    one brand with alias knowledge): "Lipton" on the pack and "Unilever
 *    Pakistan" in a record are the same company, and string comparison would
 *    accuse a genuine product. An AI-read or typed barcode never triggers it.
 *  - Packaging tampered         → the barcode on it isn't trusted.
 */

import { classifyWordmark, isNationalBrand } from "./brandRouter";
import type { BarcodeRead, BarcodeSource } from "./barcodeScanner";
import { getBarcodeCheckText, type BarcodeCheckStatus, type BilingualReason } from "@/lib/translate";

export interface BarcodeCheck {
  status: BarcodeCheckStatus;
  source: BarcodeSource | null;
  format: string | null;
  value: string | null;
  en: string;
  ur: string;
}

export interface BarcodeEvidenceInput {
  read: BarcodeRead | null;
  /** The barcode equals the identified product's barcode (catalog SKU or external record). */
  matched: boolean;
  /** Company the barcode resolves to: catalog row, exclusive GS1 prefix, or external DB record. */
  barcodeBrand: string | null;
  /** Company the packaging identifies: wordmark or catalogue image match. */
  packagingBrand: string | null;
  /** Gemini's existing tampering flag. */
  tampering: boolean;
}

export function isBarcodeMismatch(
  read: BarcodeRead | null,
  barcodeBrand: string | null,
  packagingBrand: string | null
): boolean {
  if (read?.source !== "decoded" || !read.productCode) return false;
  if (!barcodeBrand || !packagingBrand) return false;
  // A misspelled wordmark is the near-miss rule's call, not this one's.
  if (classifyWordmark(packagingBrand).status === "near_miss") return false;
  return isNationalBrand(barcodeBrand) !== isNationalBrand(packagingBrand);
}

export function assessBarcode(input: BarcodeEvidenceInput): BarcodeCheck {
  const { read } = input;
  let status: BarcodeCheckStatus;
  if (!read) status = "not_visible";
  else if (isBarcodeMismatch(read, input.barcodeBrand, input.packagingBrand)) status = "mismatch";
  else if (input.tampering) status = "tampered";
  else if (input.matched) status = "verified";
  else status = "unconfirmed";

  const text = getBarcodeCheckText(status);
  return {
    status,
    source: read?.source ?? null,
    format: read?.format ?? null,
    value: read?.value ?? null,
    en: text.en,
    ur: text.ur,
  };
}

/**
 * Reason sentence for a barcode mismatch, written in both languages directly
 * (like pixelCompareReason in verifyProduct.ts) so the brand names and code
 * survive intact.
 */
export function barcodeMismatchReason(
  code: string,
  barcodeBrand: string,
  packagingBrand: string,
  packagingDefects: boolean
): BilingualReason {
  return {
    en:
      `The barcode on this pack (${code}) is registered to ${barcodeBrand}, but the packaging identifies the product as ${packagingBrand}. ` +
      `A genuine product carries its own manufacturer's barcode` +
      (packagingDefects ? `, and the packaging inspection also failed. This is most likely a counterfeit.` : `. Treat this product as suspicious.`),
    ur:
      `اس پیک پر موجود بارکوڈ (${code}) ${barcodeBrand} کے نام درج ہے، مگر پیکنگ اس مصنوع کو ${packagingBrand} کی ظاہر کرتی ہے۔ ` +
      `اصل مصنوع پر اسی کارخانہ دار کا بارکوڈ ہوتا ہے` +
      (packagingDefects ? `، اور پیکنگ کا معائنہ بھی ناکام رہا۔ یہ غالباً نقلی مصنوع ہے۔` : `۔ اس مصنوع کو مشکوک سمجھیں۔`),
  };
}
