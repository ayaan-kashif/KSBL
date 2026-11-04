/**
 * services/scoreEngine.ts
 *
 * Calculates the final authenticity score based on weighted comparisons.
 */

import { VerificationPayload } from "./comparisonEngine";

export interface ScoreOutput {
  score: number; // 0 - 100
  barcodeScore: number;
  brandScore: number;
  packagingScore: number;
  confidenceScore: number;
}

export function calculateAuthenticityScore(payload: VerificationPayload): ScoreOutput {
  // 1. Barcode Match (20% weight)
  // Full credit if the scanned barcode matches an external reference exactly.
  // Partial credit if a barcode was legibly detected but couldn't be verified
  // against UPCItemDB/OpenFoodFacts/BarcodeLookup — those free-tier databases
  // have limited coverage for local-market products, so an unmatched (but
  // present) barcode is still positive evidence, not equivalent to no
  // barcode being visible on the packaging at all.
  // No credit at all when the barcode itself is evidence against the product:
  // a decoded barcode registered to another company, or a barcode on packaging
  // Gemini flagged as tampered. The weight is unchanged — only the input.
  const barcodeScore =
    payload.barcodeMismatch || payload.barcodeTampered
      ? 0
      : payload.barcodeMatched ? 100 : payload.barcodeDetected ? 50 : 0;

  // 2. Brand Match (25% weight)
  // Extract normalized value from Gemini evaluation (0 - 100)
  const brandScore = Math.max(0, Math.min(100, payload.geminiAnalysis.brandMatch || 0));

  // 3. Packaging Match (30% weight)
  // Extract normalized value from Gemini evaluation (0 - 100). Weighted
  // highest — packaging/print quality is the most diagnostic visual signal
  // for counterfeit detection in practice.
  const packagingScore = Math.max(0, Math.min(100, payload.geminiAnalysis.packagingMatch || 0));

  // 4. Gemini Confidence (25% weight)
  // Extract normalized value from Gemini evaluation (0 - 100)
  const confidenceScore = Math.max(0, Math.min(100, payload.geminiAnalysis.confidence || 0));

  // Formula:
  // score = (barcodeMatch * 0.20) + (brandMatch * 0.25) + (packagingMatch * 0.30) + (geminiConfidence * 0.25)
  // Rebalanced away from the old 40% barcode weight, which made it
  // mathematically impossible for a genuine, well-photographed product to
  // score above ~60 whenever its barcode wasn't in one of the three limited
  // external lookup databases — regardless of how convincing the photo was.
  const finalScore =
    barcodeScore * 0.20 +
    brandScore * 0.25 +
    packagingScore * 0.30 +
    confidenceScore * 0.25;

  return {
    score: Math.round(finalScore),
    barcodeScore,
    brandScore,
    packagingScore,
    confidenceScore,
  };
}
