/**
 * services/comparisonEngine.ts
 *
 * Merges API lookup data, Gemini Vision JSON results, and exact barcode validation.
 */

import { UnifiedProduct } from "./cacheService";
import { GeminiComparisonResult } from "./geminiVision";

export interface VerificationPayload {
  barcodeDetected: boolean;
  scannedBarcode: string | null;
  referenceBarcode: string | null;
  barcodeMatched: boolean;
  apiProductData: UnifiedProduct | null;
  geminiAnalysis: GeminiComparisonResult;
  /** Decoded barcode belongs to a different company than the packaging — see barcodeEvidence.ts. */
  barcodeMismatch?: boolean;
  /** A barcode is present on packaging Gemini flagged as tampered. */
  barcodeTampered?: boolean;
}

export function runComparisonEngine(
  scannedBarcode: string | null,
  apiProductData: UnifiedProduct | null,
  geminiAnalysis: GeminiComparisonResult,
  barcodeEvidence: {
    /** A barcode was read even if it isn't a product code (e.g. a URL QR). */
    detected?: boolean;
    mismatch?: boolean;
    tampered?: boolean;
  } = {}
): VerificationPayload {
  const barcodeDetected = !!scannedBarcode || !!barcodeEvidence.detected;

  const referenceBarcode = apiProductData?.barcode || null;
  
  // Barcode validation: does the scanned barcode match the reference barcode exactly?
  const barcodeMatched = !!scannedBarcode && !!referenceBarcode &&
    scannedBarcode.trim() === referenceBarcode.trim();

  return {
    barcodeDetected,
    scannedBarcode,
    referenceBarcode,
    barcodeMatched,
    apiProductData,
    geminiAnalysis,
    barcodeMismatch: !!barcodeEvidence.mismatch,
    barcodeTampered: !!barcodeEvidence.tampered,
  };
}
