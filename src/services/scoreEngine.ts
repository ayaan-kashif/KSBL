/**
 * services/scoreEngine.ts
 *
 * Calculates the final authenticity score based on weighted comparisons.
 */

import { VerificationPayload } from "./comparisonEngine";
import type { CheckResult, CheckSeverity } from "./medicineChecks";
import { MEDICINE_CHECK_TEXT, MEDICINE_VERDICT_TEXT } from "@/lib/translate";

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

// ─── Medicine verdict ───────────────────────────────────────────────────────
// Separate from calculateAuthenticityScore above, which is unchanged: food and
// FMCG scans never reach this function.

export type MedicineStatus = "no_problems" | "suspicious" | "counterfeit" | "expired" | "unverified";

export interface MedicineVerdict {
  status: MedicineStatus;
  /** Stored in Scan.verdict — the existing enum, no new value. */
  dbVerdict: "genuine" | "suspicious" | "unverified";
  /** Shown on screen — `counterfeit` is display-only, as on the other paths. */
  displayVerdict: "genuine" | "suspicious" | "unverified" | "counterfeit";
  score: number;
  expired: boolean;
  /** Fixed headline phrase for this status (never "genuine"/"authentic"). */
  phrase: { en: string; ur: string };
  reasonEn: string;
  reasonUr: string;
}

const MEDICINE_PENALTY: Record<CheckSeverity, number> = { critical: 60, high: 30, medium: 15, low: 5 };
const SEVERITY_ORDER: Record<CheckSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** A check that proves something against an outside reference, not just self-consistency. */
function hasStrongPositive(checks: CheckResult[], has2dCode: boolean): boolean {
  const passed = (id: CheckResult["id"]) => checks.some((c) => c.id === id && c.status === "pass");
  if (passed("gtinCatalog") || passed("drapRegistration")) return true;
  // A clean 2D code: valid GTIN, and the printed batch or expiry agrees with it.
  return has2dCode && passed("gtinChecksum") && (passed("batchMismatch") || passed("expiryMismatch"));
}

/**
 * Combine the medicine checks into the one verdict the scan shows.
 *
 *  - any critical fail          → suspicious (shown as counterfeit, "Do not use";
 *                                 an expired pack gets its own "Expired" wording)
 *  - a high fail, or 2+ warnings → suspicious
 *  - nothing failed or warned AND a strong positive (catalogue / registration
 *    match, or a clean 2D code with matching batch/expiry)
 *                                → genuine in the DB, shown as "No red flags
 *                                  found. Confirm with your pharmacist"
 *  - anything else              → unverified
 *
 * Score: 100 minus 60 / 30 / 15 / 5 per critical / high / medium / low finding
 * (fail or warn), clamped to 0–100. Skipped checks don't count. The reason is
 * the one or two most severe findings, in both languages.
 */
export function combineMedicineVerdict(checks: CheckResult[], opts: { has2dCode: boolean }): MedicineVerdict {
  const findings = checks
    .filter((c) => c.status === "fail" || c.status === "warn")
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        (a.status === b.status ? 0 : a.status === "fail" ? -1 : 1)
    );
  const fails = findings.filter((c) => c.status === "fail");
  const warns = findings.filter((c) => c.status === "warn");
  const criticalFails = fails.filter((c) => c.severity === "critical");
  const expired = criticalFails.some((c) => c.id === "expiry");
  // Medium/low "fails" weigh like warnings: only critical and high are decisive.
  const softFindings = warns.length + fails.filter((c) => c.severity === "medium" || c.severity === "low").length;

  const score = Math.max(
    0,
    Math.min(100, 100 - findings.reduce((sum, c) => sum + MEDICINE_PENALTY[c.severity], 0))
  );

  const top = findings.slice(0, 2);
  const no2d = opts.has2dCode ? null : MEDICINE_CHECK_TEXT.no2dCode;
  const reasonOf = (fallback: { en: string; ur: string }) => {
    const en = top.length ? top.map((c) => c.reasonEn).join(". ") : fallback.en;
    const ur = top.length ? top.map((c) => c.reasonUr).join("۔ ") : fallback.ur;
    return {
      reasonEn: no2d ? `${en}. ${no2d.en}.` : en.endsWith(".") ? en : `${en}.`,
      reasonUr: no2d ? `${ur}۔ ${no2d.ur}۔` : ur.endsWith("۔") ? ur : `${ur}۔`,
    };
  };

  if (criticalFails.length) {
    const onlyExpiry = criticalFails.every((c) => c.id === "expiry");
    return {
      status: onlyExpiry ? "expired" : "counterfeit",
      dbVerdict: "suspicious",
      displayVerdict: onlyExpiry ? "suspicious" : "counterfeit",
      score,
      expired,
      phrase: onlyExpiry ? MEDICINE_VERDICT_TEXT.expired : MEDICINE_VERDICT_TEXT.counterfeit,
      ...reasonOf(MEDICINE_VERDICT_TEXT.counterfeit),
    };
  }

  if (fails.some((c) => c.severity === "high") || softFindings >= 2) {
    return {
      status: "suspicious",
      dbVerdict: "suspicious",
      displayVerdict: "suspicious",
      score,
      expired,
      phrase: MEDICINE_VERDICT_TEXT.suspicious,
      ...reasonOf(MEDICINE_VERDICT_TEXT.suspicious),
    };
  }

  // A critical check (DRAP alert, cloned serial…) that failed to run means we
  // don't know — so the pack can't be called "no red flags", only unverified.
  const criticalUnavailable = checks.some(
    (c) => c.status === "skipped" && c.severity === "critical" && c.evidence?.unavailable === true
  );

  if (!findings.length && !criticalUnavailable && hasStrongPositive(checks, opts.has2dCode)) {
    const ran = checks.filter((c) => c.status !== "skipped").length;
    return {
      status: "no_problems",
      dbVerdict: "genuine",
      displayVerdict: "genuine",
      score,
      expired,
      phrase: MEDICINE_VERDICT_TEXT.noProblems,
      ...reasonOf(MEDICINE_VERDICT_TEXT.noProblemsReason(ran)),
    };
  }

  return {
    status: "unverified",
    dbVerdict: "unverified",
    displayVerdict: "unverified",
    score,
    expired,
    phrase: MEDICINE_VERDICT_TEXT.unverified,
    ...reasonOf(MEDICINE_VERDICT_TEXT.unverifiedReason),
  };
}
