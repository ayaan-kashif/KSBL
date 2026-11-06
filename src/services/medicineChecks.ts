/**
 * services/medicineChecks.ts
 *
 * The medicine checks. Every check is a pure function returning a CheckResult;
 * the database reads they need are injected (services/medicineData.ts in the
 * app, fakes in tests), and runMedicineChecks() runs them all through
 * Promise.allSettled with a per-check timeout — a check that throws or times
 * out becomes "skipped" and never stops the verdict.
 *
 *  Group A — the pack itself
 *    gtinChecksum     GTIN check digit (GS1 (01) or the linear EAN)    critical
 *    expiry           past = critical; ≤ 30 days = warn; > 6 years = medium warn
 *    mfgVsExpiry      manufacturing date after expiry / in the future   high
 *    batchMismatch    2D-code batch vs printed batch                    critical
 *    expiryMismatch   2D-code expiry vs printed expiry (month + year)   critical
 *    packaging        pharma-specific Gemini inspection                 by defect
 *  Group B — history
 *    clonedSerial     same GTIN + serial seen in another area / far away
 *  Group C — official records
 *    drapRegistration Reg. No. in the Medicine table (then the DRAP cache)
 *    gtinCatalog      GTIN in the Medicine table
 *    drapAlert        DRAP falsified/substandard/recall alerts by batch
 *    gs1Registry      external serial registry — only when configured
 *
 * The verdict is combined in services/scoreEngine.ts (combineMedicineVerdict).
 * Nothing here invents a value: missing = skipped.
 */

import crypto from "node:crypto";
import type { Gs1Data } from "./gs1Parser";
import { isValidGs1CheckDigit } from "./barcodeDecoder";
import { isGeminiFallback, type GeminiComparisonResult, type MedicinePrinted, type PharmaPackagingFlags } from "./geminiVision";
import type { MedicineVerdict } from "./scoreEngine";
import { brandsMatch, normaliseRegNo, strengthsOverlap } from "@/lib/pharmaText";
import { gtin14, normaliseBatch } from "@/lib/medicineNormalise";
import { MEDICINE_CHECK_TEXT, PHARMA_PACKAGING_ISSUE_TEXT, type BilingualReason } from "@/lib/translate";

// ─── Types ──────────────────────────────────────────────────────────────────

export type CheckStatus = "pass" | "fail" | "warn" | "skipped";
export type CheckSeverity = "critical" | "high" | "medium" | "low";
export type CheckId =
  | "gtinChecksum"
  | "expiry"
  | "mfgVsExpiry"
  | "batchMismatch"
  | "expiryMismatch"
  | "packaging"
  | "clonedSerial"
  | "drapRegistration"
  | "gtinCatalog"
  | "drapAlert"
  | "gs1Registry";

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  severity: CheckSeverity;
  reasonEn: string;
  reasonUr: string;
  evidence?: Record<string, unknown>;
}

/** A Medicine-table row (or a DRAP-cache row mapped to the same shape). */
export interface MedicineEntry {
  id: string | null;
  gtin: string | null;
  registration_no: string | null;
  brand_name: string;
  generic_name: string | null;
  strength: string | null;
  dosage_form: string | null;
  manufacturer: string | null;
  /** Where the row came from — "Medicine" or "DrapRegistration". */
  source: string;
}

export interface DrapAlertRow {
  product_name: string;
  generic_name: string | null;
  batch_no: string;
  batch_norm: string;
  manufacturer_claimed: string | null;
  alert_type: "falsified" | "substandard" | "recall" | string;
  alert_date: string;
  source_url: string;
}

/** An earlier Scan row with the same GTIN + serial. */
export interface PriorSerialScan {
  id: string;
  area_name: string | null;
  latitude: number | null;
  longitude: number | null;
  customer_id: string | null;
  /** ocr_raw_json.medicine_reporter — customer or hashed WhatsApp sender. */
  reporter: string | null;
  created_at: string;
}

export type RegistryStatus = "valid" | "invalid" | "unknown";

/** Database / registry reads the checks need — see services/medicineData.ts. */
export interface MedicineDataSource {
  priorSerialScans(barcode: string, serial: string): Promise<PriorSerialScan[]>;
  medicineByRegNo(regNo: string): Promise<MedicineEntry | null>;
  medicineByGtin(gtin: string): Promise<MedicineEntry | null>;
  drapAlerts(productName: string, batchNorm: string | null): Promise<DrapAlertRow[]>;
  /** null = no registry configured: the check is skipped and nothing is called. */
  gs1Registry(code: { gtin: string; serial: string; batch: string | null; expiry: string | null }): Promise<RegistryStatus | null>;
}

export interface MedicineAssessment {
  printed: MedicinePrinted | null;
  gs1: Gs1Data | null;
  /** A GS1 2D code was decoded. Older stock has none — never a penalty. */
  has2dCode: boolean;
  expiry: { date: string | null; source: "datamatrix" | "printed" | null; expired: boolean };
  /** Catalogue identity (Medicine table by GTIN or Reg. No.), if any. */
  identity: {
    product: {
      id: string | null;
      product_name: string;
      generic_name: string | null;
      strength: string | null;
      dosage_form: string | null;
      manufacturer: string | null;
      drap_reg_no: string | null;
    } | null;
    via: "gtin" | "registration" | null;
  };
  registration: { regNo: string | null; status: "found" | "not_found" | "mismatch" | "not_checked"; record: { brand_name: string; company: string | null } | null };
  registrationMismatch: boolean;
  /** The DRAP alert behind a drapAlert fail/warn — date and link for the reply. */
  drapAlert: { product_name: string; batch_no: string; alert_type: string; alert_date: string; source_url: string; exactBatch: boolean } | null;
  sourcesConsulted: string[];
  checks: CheckResult[];
  /** Set by the caller from combineMedicineVerdict(). */
  verdict?: MedicineVerdict;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

const result = (
  id: CheckId,
  status: CheckStatus,
  severity: CheckSeverity,
  text: BilingualReason,
  evidence?: Record<string, unknown>
): CheckResult => ({ id, status, severity, reasonEn: text.en, reasonUr: text.ur, ...(evidence ? { evidence } : {}) });

const skipped = (id: CheckId, severity: CheckSeverity, why: string): CheckResult =>
  result(id, "skipped", severity, MEDICINE_CHECK_TEXT.skipped(why));

// Shared with the import scripts — see lib/medicineNormalise.ts.
export { normaliseBatch, gtin14 };

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function iso(year: number, month: number, day: number | null): string | null {
  if (month < 1 || month > 12 || year < 2000 || year > 2099) return null;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const d = day ?? lastDay;
  if (d < 1 || d > lastDay) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/**
 * A printed date as Pakistani packs show it: "12/2027", "12-27", "DEC 2027",
 * "31.12.2027" (day first), "2027-12". Month-only dates mean the end of that
 * month. Returns null rather than guessing.
 */
export function parsePrintedDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.toUpperCase().replace(/(EXP(IRY)?|MFG|MFD|DATE|[:])/g, " ").trim();
  let m: RegExpMatchArray | null;

  if ((m = t.match(/\b(20\d{2})[./-](\d{1,2})(?:[./-](\d{1,2}))?\b/))) {
    return iso(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null);
  }
  if ((m = t.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})\b/))) {
    return iso(fullYear(m[3]), Number(m[2]), Number(m[1]));
  }
  if ((m = t.match(/\b(\d{1,2})[./\s-]+(\d{4}|\d{2})\b/))) {
    return iso(fullYear(m[2]), Number(m[1]), null);
  }
  if ((m = t.match(/\b(?:(\d{1,2})[\s.-]*)?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC)[A-Z]*[\s.,'-]*(\d{4}|\d{2})\b/))) {
    return iso(fullYear(m[3]), MONTHS[m[2].toLowerCase()], m[1] ? Number(m[1]) : null);
  }
  return null;
}

/** Today's date in Pakistan (ISO), which is what a pack's expiry refers to. */
export function todayInPakistan(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(now);
}

const DAY_MS = 86_400_000;
const daysBetween = (fromIso: string, toIso: string) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);

function addYears(isoDate: string, years: number): string {
  return `${Number(isoDate.slice(0, 4)) + years}${isoDate.slice(4)}`;
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Not a place: never compared as an area. */
const NON_AREAS = new Set(["", "location unavailable", "unknown location", "test area"]);
const normaliseArea = (a: string | null | undefined) => {
  const n = (a ?? "").trim().toLowerCase();
  return NON_AREAS.has(n) ? null : n;
};

// ─── Reporter keys ──────────────────────────────────────────────────────────

/**
 * Stable, non-reversible key for a WhatsApp sender. Raw phone numbers are
 * never stored; HMAC with the server's session secret so the key can't be
 * brute-forced back from the (small) space of Pakistani mobile numbers.
 */
export function phoneReporterKey(phone: string): string | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !phone) return null;
  return `w:${crypto.createHmac("sha256", secret).update(phone.replace(/\D/g, "")).digest("hex").slice(0, 32)}`;
}

export function customerReporterKey(customerId: string | null | undefined): string | null {
  return customerId ? `c:${customerId}` : null;
}

// ─── Group A: the pack ──────────────────────────────────────────────────────

export function checkGtinChecksum(gtin: string | null | undefined): CheckResult {
  const code = (gtin ?? "").trim();
  if (!code) return skipped("gtinChecksum", "critical", "no product code");
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return skipped("gtinChecksum", "critical", "not a GTIN");
  return isValidGs1CheckDigit(code.padStart(14, "0"))
    ? result("gtinChecksum", "pass", "critical", MEDICINE_CHECK_TEXT.gtinValid, { gtin: code })
    : result("gtinChecksum", "fail", "critical", MEDICINE_CHECK_TEXT.gtinInvalid(code), { gtin: code });
}

export function checkExpiry(expiry: string | null, now = new Date()): CheckResult {
  if (!expiry) return skipped("expiry", "critical", "no expiry date visible");
  const today = todayInPakistan(now);
  // Valid through the expiry date itself.
  if (expiry < today) return result("expiry", "fail", "critical", MEDICINE_CHECK_TEXT.expired(expiry), { expiry });
  const days = daysBetween(today, expiry);
  if (days <= 30) return result("expiry", "warn", "low", MEDICINE_CHECK_TEXT.expiringSoon(expiry, days), { expiry, days });
  if (expiry > addYears(today, 6)) return result("expiry", "warn", "medium", MEDICINE_CHECK_TEXT.expiryFarOff(expiry), { expiry });
  return result("expiry", "pass", "critical", MEDICINE_CHECK_TEXT.expiryOk(expiry), { expiry });
}

export function checkMfgVsExpiry(mfg: string | null, expiry: string | null, now = new Date()): CheckResult {
  if (!mfg) return skipped("mfgVsExpiry", "high", "no manufacturing date visible");
  if (mfg > todayInPakistan(now)) return result("mfgVsExpiry", "fail", "high", MEDICINE_CHECK_TEXT.mfgInFuture(mfg), { mfg });
  if (!expiry) return skipped("mfgVsExpiry", "high", "no expiry date visible");
  return mfg >= expiry
    ? result("mfgVsExpiry", "fail", "high", MEDICINE_CHECK_TEXT.mfgAfterExpiry(mfg, expiry), { mfg, expiry })
    : result("mfgVsExpiry", "pass", "high", MEDICINE_CHECK_TEXT.mfgOk, { mfg, expiry });
}

export function checkBatchMismatch(coded: string | null | undefined, printed: string | null | undefined): CheckResult {
  const a = normaliseBatch(coded);
  const b = normaliseBatch(printed);
  if (!a) return skipped("batchMismatch", "critical", "no batch in the 2D code");
  if (!b) return skipped("batchMismatch", "critical", "no batch printed");
  return a === b
    ? result("batchMismatch", "pass", "critical", MEDICINE_CHECK_TEXT.batchMatch, { coded, printed })
    : result("batchMismatch", "fail", "critical", MEDICINE_CHECK_TEXT.batchMismatch(printed!, coded!), { coded, printed });
}

export function checkExpiryMismatch(codedIso: string | null | undefined, printedText: string | null | undefined): CheckResult {
  if (!codedIso) return skipped("expiryMismatch", "critical", "no expiry in the 2D code");
  const printedIso = parsePrintedDate(printedText);
  if (!printedIso) return skipped("expiryMismatch", "critical", "no readable expiry printed");
  // Month precision: packs often print only MM/YYYY.
  return codedIso.slice(0, 7) === printedIso.slice(0, 7)
    ? result("expiryMismatch", "pass", "critical", MEDICINE_CHECK_TEXT.expiryMatch, { coded: codedIso, printed: printedText })
    : result("expiryMismatch", "fail", "critical", MEDICINE_CHECK_TEXT.expiryMismatch(printedText!, codedIso.slice(0, 7)), {
        coded: codedIso,
        printed: printedText,
      });
}

/** Packaging defect → severity. "missing…" items only count with a back photo. */
const PACKAGING_SEVERITY: Record<keyof PharmaPackagingFlags | "tampering", CheckSeverity> = {
  sealBroken: "high",
  tampering: "high",
  spellingErrors: "high",
  logoMismatch: "high",
  stripBoxMismatch: "high",
  blurryPrint: "medium",
  blisterFoilDefect: "medium",
  missingRegNo: "medium",
  missingUrduOrMrp: "low",
  missingKeepOutOfReach: "low",
};
const BACK_ONLY: (keyof PharmaPackagingFlags)[] = ["missingRegNo", "missingUrduOrMrp", "missingKeepOutOfReach"];
const SEVERITY_RANK: Record<CheckSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function checkPackaging(
  gemini: Pick<GeminiComparisonResult, "tampering" | "pharmaPackaging"> | null,
  hasBackImage: boolean
): CheckResult {
  if (!gemini || isGeminiFallback(gemini as GeminiComparisonResult)) {
    return skipped("packaging", "high", "packaging inspection unavailable");
  }
  const flags = gemini.pharmaPackaging ?? null;
  const issues: (keyof typeof PACKAGING_SEVERITY)[] = [];
  if (gemini.tampering) issues.push("tampering");
  if (flags) {
    for (const key of Object.keys(PACKAGING_SEVERITY) as (keyof PharmaPackagingFlags)[]) {
      if (key === ("tampering" as string)) continue;
      if (!flags[key]) continue;
      if (BACK_ONLY.includes(key) && !hasBackImage) continue;
      if (key === "sealBroken" && issues.includes("tampering")) continue;
      issues.push(key);
    }
  }
  if (!issues.length) {
    return flags
      ? result("packaging", "pass", "high", MEDICINE_CHECK_TEXT.packagingOk)
      : skipped("packaging", "high", "no pharma packaging inspection returned");
  }
  issues.sort((a, b) => SEVERITY_RANK[PACKAGING_SEVERITY[a]] - SEVERITY_RANK[PACKAGING_SEVERITY[b]]);
  const worst = PACKAGING_SEVERITY[issues[0]];
  const en = issues.map((i) => PHARMA_PACKAGING_ISSUE_TEXT[i].en).join(", ");
  const ur = issues.map((i) => PHARMA_PACKAGING_ISSUE_TEXT[i].ur).join("، ");
  return result(
    "packaging",
    SEVERITY_RANK[worst] <= SEVERITY_RANK.high ? "fail" : "warn",
    worst,
    MEDICINE_CHECK_TEXT.packagingIssues(en, ur),
    { issues }
  );
}

// ─── Group B: history ───────────────────────────────────────────────────────

export interface CurrentScan {
  area: string | null;
  latitude: number | null;
  longitude: number | null;
  /** customerReporterKey() / phoneReporterKey() of whoever is scanning now. */
  reporter: string | null;
  customerId: string | null;
  now?: Date;
}

/**
 * Same GTIN + serial seen before. A genuine pack's serial is unique, so the
 * same code turning up in another area, or more than 20 km away, means the
 * code was copied. One person re-scanning their own pack within 24h is
 * ignored. Many scans in ONE area is only a warning — a pharmacy counter
 * scanning a pack several times is plausible.
 */
export function checkClonedSerial(
  prior: PriorSerialScan[],
  current: CurrentScan,
  opts: { maxKm: number; maxScans: number }
): CheckResult {
  const now = (current.now ?? new Date()).getTime();
  const relevant = prior.filter((p) => {
    const sameReporter =
      (!!current.customerId && p.customer_id === current.customerId) ||
      (!!current.reporter && p.reporter === current.reporter);
    return !(sameReporter && now - Date.parse(p.created_at) < DAY_MS);
  });
  if (!relevant.length) {
    return result("clonedSerial", "pass", "critical", MEDICINE_CHECK_TEXT.serialFirst, { priorScans: prior.length });
  }

  const currentArea = normaliseArea(current.area);
  const hasCoords = current.latitude != null && current.longitude != null;
  for (const p of relevant) {
    const priorArea = normaliseArea(p.area_name);
    if (hasCoords && p.latitude != null && p.longitude != null) {
      const km = Math.round(haversineKm(current.latitude!, current.longitude!, p.latitude, p.longitude));
      if (km > opts.maxKm) {
        return result(
          "clonedSerial",
          "fail",
          "critical",
          priorArea ? MEDICINE_CHECK_TEXT.cloned(p.area_name!.trim()) : MEDICINE_CHECK_TEXT.clonedFar(km),
          { priorArea: p.area_name, km, priorScanId: p.id }
        );
      }
    }
    if (currentArea && priorArea && priorArea !== currentArea) {
      return result("clonedSerial", "fail", "critical", MEDICINE_CHECK_TEXT.cloned(p.area_name!.trim()), {
        priorArea: p.area_name,
        priorScanId: p.id,
      });
    }
  }
  // No location for this scan: earlier scans from two different areas is still a copy.
  if (!currentArea && !hasCoords) {
    const areas = [...new Set(relevant.map((p) => normaliseArea(p.area_name)).filter(Boolean))];
    if (areas.length >= 2) {
      const named = relevant.find((p) => normaliseArea(p.area_name) === areas[1])!;
      return result("clonedSerial", "fail", "critical", MEDICINE_CHECK_TEXT.cloned(named.area_name!.trim()), { areas });
    }
  }

  const total = relevant.length + 1;
  if (total > opts.maxScans) {
    return result("clonedSerial", "warn", "high", MEDICINE_CHECK_TEXT.serialRepeated(total), { scans: total });
  }
  return result("clonedSerial", "pass", "critical", MEDICINE_CHECK_TEXT.serialSeenHere(relevant.length), { scans: total });
}

// ─── Group C: official records ──────────────────────────────────────────────

export function checkDrapRegistration(
  regNo: string | null,
  record: MedicineEntry | null,
  printed: MedicinePrinted | null
): CheckResult {
  if (!regNo) return skipped("drapRegistration", "high", "no Reg. No. visible");
  if (!record) return result("drapRegistration", "warn", "low", MEDICINE_CHECK_TEXT.regNotFound(regNo), { regNo });
  const differs =
    brandsMatch(record.brand_name, printed?.brandName) === false ||
    brandsMatch(record.generic_name, printed?.genericName) === false ||
    strengthsOverlap(record.strength, printed?.strength) === false;
  return differs
    ? result("drapRegistration", "fail", "high", MEDICINE_CHECK_TEXT.regMismatch(regNo, record.brand_name), {
        regNo,
        registeredTo: record.brand_name,
        source: record.source,
      })
    : result("drapRegistration", "pass", "high", MEDICINE_CHECK_TEXT.regFound(regNo, record.brand_name), {
        regNo,
        source: record.source,
      });
}

export function checkGtinCatalog(gtin: string | null, entry: MedicineEntry | null, printed: MedicinePrinted | null): CheckResult {
  if (!gtin) return skipped("gtinCatalog", "high", "no product code");
  if (!entry) return skipped("gtinCatalog", "high", "product code not in the medicine catalogue");
  const differs =
    brandsMatch(entry.brand_name, printed?.brandName) === false ||
    strengthsOverlap(entry.strength, printed?.strength) === false;
  return differs
    ? result("gtinCatalog", "fail", "high", MEDICINE_CHECK_TEXT.catalogMismatch(entry.brand_name), { gtin, catalogBrand: entry.brand_name })
    : result("gtinCatalog", "pass", "high", MEDICINE_CHECK_TEXT.catalogMatch(entry.brand_name), { gtin });
}

export function checkDrapAlert(alerts: DrapAlertRow[], productName: string | null, batch: string | null): CheckResult {
  if (!productName) return skipped("drapAlert", "critical", "product name not visible");
  const batchNorm = normaliseBatch(batch);
  const sameProduct = alerts.filter((a) => brandsMatch(a.product_name, productName) === true);
  const exact = batchNorm ? sameProduct.find((a) => a.batch_norm === batchNorm) : undefined;
  const evidence = (a: DrapAlertRow, exactBatch: boolean) => ({
    product_name: a.product_name,
    batch_no: a.batch_no,
    alert_type: a.alert_type,
    alert_date: a.alert_date,
    source_url: a.source_url,
    exactBatch,
  });
  if (exact) {
    return result(
      "drapAlert",
      "fail",
      "critical",
      MEDICINE_CHECK_TEXT.drapFlagged(exact.product_name, exact.batch_no, exact.alert_type, exact.alert_date),
      evidence(exact, true)
    );
  }
  if (sameProduct.length) {
    const latest = [...sameProduct].sort((a, b) => b.alert_date.localeCompare(a.alert_date))[0];
    return result("drapAlert", "warn", "low", MEDICINE_CHECK_TEXT.drapProductAlert(latest.product_name, latest.alert_date), evidence(latest, false));
  }
  return result("drapAlert", "pass", "critical", MEDICINE_CHECK_TEXT.drapNoAlert);
}

export function checkGs1Registry(status: RegistryStatus | null): CheckResult {
  if (status === null) return skipped("gs1Registry", "high", "no registry configured");
  if (status === "valid") return result("gs1Registry", "pass", "high", MEDICINE_CHECK_TEXT.registryValid);
  if (status === "invalid") return result("gs1Registry", "fail", "high", MEDICINE_CHECK_TEXT.registryInvalid);
  return skipped("gs1Registry", "high", "registry had no answer");
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/** Per-check ceiling; a slower check is skipped, never waited on. */
export const CHECK_TIMEOUT_MS = 3500;

export interface MedicineCheckInput {
  gs1: Gs1Data | null;
  /** Retail product code from the barcode (GTIN-13 for old packs), if any. */
  productCode: string | null;
  printed: MedicinePrinted | null;
  gemini: Pick<GeminiComparisonResult, "tampering" | "pharmaPackaging"> | null;
  hasBackImage: boolean;
  current: CurrentScan;
  clone: { maxKm: number; maxScans: number };
  now?: Date;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => timer && clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]);
}

const NOMINAL_SEVERITY: Record<CheckId, CheckSeverity> = {
  gtinChecksum: "critical",
  expiry: "critical",
  mfgVsExpiry: "high",
  batchMismatch: "critical",
  expiryMismatch: "critical",
  packaging: "high",
  clonedSerial: "critical",
  drapRegistration: "high",
  gtinCatalog: "high",
  drapAlert: "critical",
  gs1Registry: "high",
};

/** Display order of the "Checks performed" list. */
export const CHECK_ORDER: CheckId[] = [
  "drapAlert", "expiry", "gtinChecksum", "batchMismatch", "expiryMismatch", "clonedSerial",
  "drapRegistration", "gtinCatalog", "packaging", "mfgVsExpiry", "gs1Registry",
];

export async function runMedicineChecks(
  input: MedicineCheckInput,
  data: MedicineDataSource,
  timeoutMs = CHECK_TIMEOUT_MS
): Promise<MedicineAssessment> {
  const { gs1, printed } = input;
  const now = input.now ?? new Date();
  const has2dCode = !!gs1?.isGs1;
  const no2d = (id: CheckId) => result(id, "skipped", NOMINAL_SEVERITY[id], MEDICINE_CHECK_TEXT.no2dCode);

  const gtin = gs1?.gtin ?? input.productCode ?? null;
  const barcodeKey = gtin && gtin.length === 14 && gtin.startsWith("0") ? gtin.slice(1) : gtin;
  const expiryDate = gs1?.expiry ?? parsePrintedDate(printed?.expiryDate);
  const mfgDate = gs1?.mfgDate ?? parsePrintedDate(printed?.mfgDate);
  // "000000" is a placeholder, not a registration number.
  const regNoRaw = normaliseRegNo(printed?.drapRegNo);
  const regNo = regNoRaw && !/^0+$/.test(regNoRaw) ? regNoRaw : null;
  const batch = gs1?.batch ?? printed?.batch ?? null;

  // Shared lookups, started once and awaited by whichever checks need them.
  let gtinEntry: MedicineEntry | null = null;
  let regEntry: MedicineEntry | null = null;
  const gtinLookup = gtin14(gtin) ? withTimeout(data.medicineByGtin(gtin14(gtin)!), timeoutMs) : Promise.resolve(null);
  const regLookup = regNo ? withTimeout(data.medicineByRegNo(regNo), timeoutMs) : Promise.resolve(null);

  let alertHit: MedicineAssessment["drapAlert"] = null;
  const sources = new Set<string>();

  const tasks: [CheckId, () => CheckResult | Promise<CheckResult>][] = [
    ["gtinChecksum", () => checkGtinChecksum(gtin)],
    ["expiry", () => checkExpiry(expiryDate, now)],
    ["mfgVsExpiry", () => checkMfgVsExpiry(mfgDate, expiryDate, now)],
    ["batchMismatch", () => (has2dCode ? checkBatchMismatch(gs1?.batch, printed?.batch) : no2d("batchMismatch"))],
    ["expiryMismatch", () => (has2dCode ? checkExpiryMismatch(gs1?.expiry, printed?.expiryDate) : no2d("expiryMismatch"))],
    ["packaging", () => checkPackaging(input.gemini, input.hasBackImage)],
    [
      "clonedSerial",
      async () => {
        if (!has2dCode) return no2d("clonedSerial");
        if (!barcodeKey || !gs1?.serial) return skipped("clonedSerial", "critical", "no serial in the 2D code");
        const prior = await withTimeout(data.priorSerialScans(barcodeKey, gs1.serial), timeoutMs);
        sources.add("ShelfWatch scan history");
        return checkClonedSerial(prior, { ...input.current, now }, input.clone);
      },
    ],
    [
      "drapRegistration",
      async () => {
        regEntry = await regLookup;
        if (regNo) sources.add(regEntry?.source === "DrapRegistration" ? "DRAP price index" : "ShelfWatch DRAP list");
        return checkDrapRegistration(regNo, regEntry, printed);
      },
    ],
    [
      "gtinCatalog",
      async () => {
        gtinEntry = await gtinLookup;
        if (gtin) sources.add("ShelfWatch medicine catalogue");
        return checkGtinCatalog(gtin, gtinEntry, printed);
      },
    ],
    [
      "drapAlert",
      async () => {
        const productName = printed?.brandName ?? (await gtinLookup.catch(() => null))?.brand_name ?? null;
        if (!productName) return checkDrapAlert([], null, batch);
        const alerts = await withTimeout(data.drapAlerts(productName, normaliseBatch(batch)), timeoutMs);
        sources.add("DRAP alerts");
        const check = checkDrapAlert(alerts, productName, batch);
        if (check.status !== "pass" && check.evidence) alertHit = check.evidence as NonNullable<MedicineAssessment["drapAlert"]>;
        return check;
      },
    ],
    [
      "gs1Registry",
      async () => {
        if (!has2dCode) return no2d("gs1Registry");
        if (!gs1?.gtin || !gs1.serial) return skipped("gs1Registry", "high", "no serial in the 2D code");
        const status = await withTimeout(
          data.gs1Registry({ gtin: gs1.gtin, serial: gs1.serial, batch: gs1.batch, expiry: gs1.expiry }),
          timeoutMs
        );
        if (status !== null) sources.add("GS1 / DRAP registry");
        return checkGs1Registry(status);
      },
    ],
  ];

  const settled = await Promise.allSettled(tasks.map(([, run]) => Promise.resolve().then(run)));
  const checks = settled.map((s, i): CheckResult => {
    const id = tasks[i][0];
    if (s.status === "fulfilled") return s.value;
    console.warn(`[Medicine] check ${id} skipped:`, s.reason instanceof Error ? s.reason.message : s.reason);
    // `unavailable`: the check should have run but couldn't (timeout, DB
    // down) — unlike "nothing to check". combineMedicineVerdict won't call a
    // pack "no red flags" while a critical check is unavailable.
    return { ...skipped(id, NOMINAL_SEVERITY[id], "check unavailable"), evidence: { unavailable: true } };
  });
  checks.sort((a, b) => CHECK_ORDER.indexOf(a.id) - CHECK_ORDER.indexOf(b.id));

  const identityEntry: MedicineEntry | null = (gtinEntry as MedicineEntry | null) ?? (regEntry as MedicineEntry | null);
  const regCheck = checks.find((c) => c.id === "drapRegistration");
  const reg = regEntry as MedicineEntry | null;

  return {
    printed,
    gs1,
    has2dCode,
    expiry: {
      date: expiryDate,
      source: gs1?.expiry ? "datamatrix" : expiryDate ? "printed" : null,
      expired: !!expiryDate && expiryDate < todayInPakistan(now),
    },
    identity: {
      product: identityEntry
        ? {
            id: identityEntry.source === "Medicine" ? identityEntry.id : null,
            product_name: identityEntry.brand_name,
            generic_name: identityEntry.generic_name,
            strength: identityEntry.strength,
            dosage_form: identityEntry.dosage_form,
            manufacturer: identityEntry.manufacturer,
            drap_reg_no: identityEntry.registration_no,
          }
        : null,
      via: gtinEntry ? "gtin" : regEntry ? "registration" : null,
    },
    registration: {
      regNo,
      status: !regNo || regCheck?.status === "skipped" ? "not_checked" : regCheck?.status === "fail" ? "mismatch" : reg ? "found" : "not_found",
      record: reg ? { brand_name: reg.brand_name, company: reg.manufacturer } : null,
    },
    registrationMismatch: regCheck?.status === "fail",
    drapAlert: alertHit,
    sourcesConsulted: [...sources],
    checks,
  };
}
