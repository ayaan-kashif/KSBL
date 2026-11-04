/**
 * services/medicineVerdict.ts
 *
 * Combines the medicine checks (services/medicineChecks.ts) plus the existing
 * Gemini packaging inspection into the existing verdict shape — DbVerdict for
 * the Scan row, DisplayVerdict for the screens. No new Verdict enum value.
 *
 *  counterfeit / suspicious — any hard failure: duplicate serial, DataMatrix
 *      vs print mismatch, invalid GTIN or GTIN prefix of another company,
 *      registration belonging to another product/company (or absent from the
 *      authoritative registry), packaging mismatch or tampering against the
 *      official reference. Two or more independent failures → counterfeit.
 *  genuine (shown as "No problems found — official DRAP verification
 *      pending", NEVER as genuine) — no failures, no warnings, and at least one
 *      check passed against an EXTERNAL reference (catalogue match by GTIN or
 *      image, or DRAP registration). Codes that merely agree with each other,
 *      or a brand name matched from the print, are not enough: a counterfeiter
 *      can print a self-consistent DataMatrix and the right name.
 *  unverified — everything else. Not found ≠ fake.
 *
 * Expiry is reported separately and never changes the authenticity verdict:
 * an expired genuine pack is unsafe, but it is not a counterfeit.
 *
 * Scores (the screens' "confidence"): 0 beside counterfeit; the unverified
 * band (≤ 39) beside suspicious/unverified, as elsewhere; at most 90 for "no
 * problems found", so a medicine never reads as 100% original.
 */

import type { GeminiComparisonResult } from "./geminiVision";
import { isGeminiFallback } from "./geminiVision";
import type { MedicineAssessment, MedicineCheck } from "./medicineChecks";
import type { DbVerdict, DisplayVerdict } from "./verificationPaths";
import { MEDICINE_CHECK_TEXT, MEDICINE_VERDICT_TEXT, type BilingualReason } from "@/lib/translate";

export type MedicineStatus = "no_problems" | "suspicious" | "counterfeit" | "unverified";

export interface MedicineVerdict {
  status: MedicineStatus;
  dbVerdict: DbVerdict;
  displayVerdict: DisplayVerdict;
  score: number;
  expired: boolean;
  /** Headline phrase pair for this status (fixed text). */
  phrase: BilingualReason;
  reasonEn: string;
  reasonUr: string;
}

const NO_PROBLEMS_MAX_SCORE = 90;
const UNVERIFIED_MAX_SCORE = 39;

/** Display order of the check lines. */
const CHECK_ORDER: MedicineCheck["id"][] = ["identity", "registration", "packaging", "code_consistency", "expiry", "duplicate_serial"];

/**
 * Packaging against the official reference image. Scores from a comparison
 * WITHOUT a reference are generic impressions, so only tampering counts then.
 */
export function packagingCheck(gemini: GeminiComparisonResult, hasReference: boolean): MedicineCheck {
  if (isGeminiFallback(gemini)) return { id: "packaging", status: "not_checked", ...MEDICINE_CHECK_TEXT.packagingUnavailable };
  if (gemini.tampering) return { id: "packaging", status: "fail", ...MEDICINE_CHECK_TEXT.packagingTampered };
  if (!hasReference) return { id: "packaging", status: "not_checked", ...MEDICINE_CHECK_TEXT.packagingNoReference };
  const wrong = gemini.logoMatch < 50 || gemini.packagingMatch < 50 || gemini.brandMatch < 50;
  return wrong
    ? { id: "packaging", status: "fail", ...MEDICINE_CHECK_TEXT.packagingMismatch }
    : { id: "packaging", status: "pass", ...MEDICINE_CHECK_TEXT.packagingOk };
}

export function sortChecks(checks: MedicineCheck[]): MedicineCheck[] {
  return [...checks].sort((a, b) => CHECK_ORDER.indexOf(a.id) - CHECK_ORDER.indexOf(b.id));
}

export function decideMedicineVerdict(assessment: MedicineAssessment): MedicineVerdict {
  const checks = assessment.checks;
  const expired = assessment.expiry.expired;
  // Expiry is reported on its own and never decides authenticity.
  const authenticity = checks.filter((c) => c.id !== "expiry");
  const fails = authenticity.filter((c) => c.status === "fail");
  const warnings = authenticity.filter((c) => c.status === "warning");
  const passes = authenticity.filter((c) => c.status === "pass");
  const judged = passes.length + fails.length + warnings.length;
  const passRatio = judged ? passes.length / judged : 0;

  if (fails.length) {
    const counterfeit = fails.length >= 2;
    const more = fails.length > 1 ? MEDICINE_VERDICT_TEXT.moreProblems(fails.length - 1) : { en: "", ur: "" };
    return {
      status: counterfeit ? "counterfeit" : "suspicious",
      dbVerdict: "suspicious",
      displayVerdict: counterfeit ? "counterfeit" : "suspicious",
      score: counterfeit ? 0 : Math.round(passRatio * UNVERIFIED_MAX_SCORE),
      expired,
      phrase: MEDICINE_VERDICT_TEXT.suspicious,
      reasonEn: `${fails[0].en}${more.en}`,
      reasonUr: `${fails[0].ur}${more.ur}`,
    };
  }

  // A catalogue match counts only by code or image: a name matched from the
  // print alone is what any counterfeit would also print.
  const strongIdentity = assessment.identity.via === "gtin" || assessment.identity.via === "image";
  const externalPass = authenticity.some(
    (c) => c.status === "pass" && (c.id === "registration" || (c.id === "identity" && strongIdentity))
  );
  if (externalPass && !warnings.length) {
    return {
      status: "no_problems",
      dbVerdict: "genuine",
      displayVerdict: "genuine",
      score: Math.round(passRatio * NO_PROBLEMS_MAX_SCORE),
      expired,
      phrase: MEDICINE_VERDICT_TEXT.noProblems,
      reasonEn: MEDICINE_VERDICT_TEXT.noProblems.en,
      reasonUr: MEDICINE_VERDICT_TEXT.noProblems.ur,
    };
  }

  return {
    status: "unverified",
    dbVerdict: "unverified",
    displayVerdict: "unverified",
    score: Math.round(passRatio * UNVERIFIED_MAX_SCORE),
    expired,
    phrase: MEDICINE_VERDICT_TEXT.unverified,
    reasonEn: warnings[0]?.en ?? MEDICINE_VERDICT_TEXT.unverifiedReason.en,
    reasonUr: warnings[0]?.ur ?? MEDICINE_VERDICT_TEXT.unverifiedReason.ur,
  };
}
