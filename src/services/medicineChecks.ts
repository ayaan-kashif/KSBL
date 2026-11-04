/**
 * services/medicineChecks.ts
 *
 * The medicine-specific checks, shared by both pipelines (/api/verify's
 * medicine path and lib/verifyProduct.ts for WhatsApp / /api/scan):
 *
 *  - Expiry            — GS1 (17), else the printed expiry, against today in
 *                        Pakistan. Expired is reported separately from
 *                        counterfeit: an expired genuine pack is still unsafe.
 *  - Code consistency  — DataMatrix vs printed batch and expiry, and the GTIN
 *                        check digit. A mismatch needs BOTH values clearly
 *                        present; a one-character batch difference is treated
 *                        as a possible misread, not as evidence.
 *  - Duplicate serial  — every (01)+(21) pair is recorded; the same serial from
 *                        2+ areas or 3+ people is a cloned code. (A pharmacist
 *                        and then the customer scanning one pack is 2 people
 *                        in 1 area, which is normal.)
 *
 *  - Identity          — the medicine catalog (services/medicineCatalog.ts).
 *                        Not found is neutral, never a failure.
 *  - Registration      — the printed (or catalogued) DRAP number against the
 *                        DRAP cache (services/drapLookup.ts). Fails only when
 *                        the number belongs to another product/company, or the
 *                        authoritative registry says it doesn't exist.
 *
 * The verdict is combined in a later phase. Nothing here throws, and nothing
 * here invents a value: missing = null.
 */

import crypto from "node:crypto";
import type { Gs1Data } from "./gs1Parser";
import { prefixOwner } from "./brandRouter";
import { identifyByText, type MedicineIdentity } from "./medicineCatalog";
import { lookupRegistration, type DrapLookupResult } from "./drapLookup";
import type { MedicineVerdict } from "./medicineVerdict";
import { brandsMatch, companiesMatch, strengthsOverlap } from "@/lib/pharmaText";
import type { MedicinePrinted } from "./geminiVision";
import { MEDICINE_CHECK_TEXT, type BilingualReason } from "@/lib/translate";

export type MedicineCheckId = "identity" | "registration" | "packaging" | "code_consistency" | "expiry" | "duplicate_serial";
export type MedicineCheckStatus = "pass" | "fail" | "warning" | "not_checked";

export interface MedicineCheck extends BilingualReason {
  id: MedicineCheckId;
  status: MedicineCheckStatus;
}

export interface ExpiryResult {
  /** ISO date; month-only printed expiries resolve to the month's last day. */
  date: string | null;
  source: "datamatrix" | "printed" | null;
  expired: boolean;
}

export interface SerialResult {
  recorded: boolean;
  totalScans: number | null;
  distinctReporters: number | null;
  distinctAreas: number | null;
  duplicate: boolean;
}

export interface MedicineAssessment {
  printed: MedicinePrinted | null;
  gs1: Gs1Data | null;
  expiry: ExpiryResult;
  /** Strong counterfeit signal: DataMatrix contradicts the print, or the GTIN is invalid. */
  codeMismatch: boolean;
  serial: SerialResult;
  identity: MedicineIdentity;
  registration: DrapLookupResult & { regNo: string | null };
  /** Registration number on record for a different product or company. */
  registrationMismatch: boolean;
  /** Data sources that actually ran on this scan, e.g. "DRAP price index". */
  sourcesConsulted: string[];
  checks: MedicineCheck[];
  /** Set by the caller once the packaging check is in — services/medicineVerdict.ts. */
  verdict?: MedicineVerdict;
}

/** Areas/reporters at which one serial counts as cloned — see header. */
const DUPLICATE_MIN_AREAS = 2;
const DUPLICATE_MIN_REPORTERS = 3;
const SERIAL_RPC_TIMEOUT_MS = 4000;

/** Not a place: never counted as a distinct area. */
const NON_AREAS = new Set(["", "location unavailable", "unknown location"]);

// ─── Dates ──────────────────────────────────────────────────────────────────

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
function todayInPakistan(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(now);
}

function evaluateExpiry(gs1: Gs1Data | null, printed: MedicinePrinted | null, now?: Date): ExpiryResult {
  const coded = gs1?.expiry ?? null;
  const printedDate = parsePrintedDate(printed?.expiryDate);
  const date = coded ?? printedDate;
  return {
    date,
    source: coded ? "datamatrix" : printedDate ? "printed" : null,
    // Valid through the expiry date itself.
    expired: !!date && date < todayInPakistan(now),
  };
}

// ─── Code consistency ───────────────────────────────────────────────────────

const normaliseBatch = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
}

function checkCodeConsistency(gs1: Gs1Data | null, printed: MedicinePrinted | null): { check: MedicineCheck; mismatch: boolean } {
  const result = (status: MedicineCheckStatus, text: BilingualReason, mismatch = false) => ({
    check: { id: "code_consistency" as const, status, ...text },
    mismatch,
  });

  if (!gs1) return result("not_checked", MEDICINE_CHECK_TEXT.codesNotChecked);

  // An invalid GTIN check digit can't come off a genuine printing line.
  if (gs1.gtin && !gs1.valid) return result("fail", MEDICINE_CHECK_TEXT.gtinInvalid, true);

  let compared = 0;
  if (gs1.batch && printed?.batch) {
    compared++;
    const coded = normaliseBatch(gs1.batch);
    const shown = normaliseBatch(printed.batch);
    if (coded !== shown) {
      // One character apart is how a photo misread looks (0/O, 1/I, 8/B);
      // a genuine reprint never differs by exactly that little by accident.
      if (editDistance(coded, shown) <= 1) {
        return result("warning", MEDICINE_CHECK_TEXT.codeUnsure(printed.batch, gs1.batch));
      }
      return result("fail", MEDICINE_CHECK_TEXT.codeMismatch("batch", printed.batch, gs1.batch), true);
    }
  }

  const printedExpiry = parsePrintedDate(printed?.expiryDate);
  if (gs1.expiry && printedExpiry) {
    compared++;
    // Month precision: packs often print only MM/YYYY.
    if (gs1.expiry.slice(0, 7) !== printedExpiry.slice(0, 7)) {
      return result("fail", MEDICINE_CHECK_TEXT.codeMismatch("expiry", printed!.expiryDate!, gs1.expiry.slice(0, 7)), true);
    }
  }

  return compared > 0
    ? result("pass", MEDICINE_CHECK_TEXT.codesMatch)
    : result("not_checked", MEDICINE_CHECK_TEXT.codesNotChecked);
}

// ─── Duplicate serial ───────────────────────────────────────────────────────

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

async function recordSerial(
  gtin: string,
  serial: string,
  batch: string | null,
  reporterKey: string | null,
  area: string | null
): Promise<SerialResult | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Service role only — the function is not executable with the anon key.
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;

  const cleanArea = area && !NON_AREAS.has(area.trim().toLowerCase()) ? area.trim() : null;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/record_medicine_serial`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_gtin: gtin, p_serial: serial, p_batch: batch, p_reporter: reporterKey, p_area: cleanArea }),
      signal: AbortSignal.timeout(SERIAL_RPC_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[MedicineChecks] record_medicine_serial returned ${res.status}: ${await res.text()}`);
      return null;
    }
    const row = (await res.json())?.[0];
    if (!row) return null;
    const distinctAreas = Number(row.distinct_areas);
    const distinctReporters = Number(row.distinct_reporters);
    return {
      recorded: true,
      totalScans: Number(row.total_scans),
      distinctReporters,
      distinctAreas,
      duplicate: distinctAreas >= DUPLICATE_MIN_AREAS || distinctReporters >= DUPLICATE_MIN_REPORTERS,
    };
  } catch (err) {
    console.error("[MedicineChecks] Serial recording failed:", err);
    return null;
  }
}

const NO_SERIAL: SerialResult = {
  recorded: false,
  totalScans: null,
  distinctReporters: null,
  distinctAreas: null,
  duplicate: false,
};

// ─── Public API ─────────────────────────────────────────────────────────────

export interface MedicineCheckInput {
  gs1: Gs1Data | null;
  /** GTIN-13 from a linear barcode (old packs) when there is no GS1 code. */
  productCode?: string | null;
  /** Catalog match found before the Gemini call (GTIN / image), if any. */
  identity?: MedicineIdentity | null;
  printed: MedicinePrinted | null;
  /** customerReporterKey() / phoneReporterKey(), or null when anonymous. */
  reporterKey: string | null;
  area: string | null;
  now?: Date;
}

export async function assessMedicine(input: MedicineCheckInput): Promise<MedicineAssessment> {
  const { gs1, printed } = input;
  const checks: MedicineCheck[] = [];

  const expiry = evaluateExpiry(gs1, printed, input.now);
  checks.push({
    id: "expiry",
    ...(!expiry.date
      ? { status: "not_checked" as const, ...MEDICINE_CHECK_TEXT.expiryUnknown }
      : expiry.expired
        ? { status: "fail" as const, ...MEDICINE_CHECK_TEXT.expiryExpired(expiry.date) }
        : { status: "pass" as const, ...MEDICINE_CHECK_TEXT.expiryValid(expiry.date) }),
  });

  const sources = new Set<string>(["ShelfWatch medicine catalogue"]);

  // ── Identity ──────────────────────────────────────────────────────────────
  let identity = input.identity?.product ? input.identity : await identifyByText(printed?.brandName ?? null, printed?.strength ?? null);
  identity ??= { product: null, via: null, similarity: null };
  if (identity.product?.manufacturer) sources.add(`${identity.product.manufacturer} catalogue`);
  checks.push({
    id: "identity",
    ...(identity.product
      ? { status: "pass" as const, ...MEDICINE_CHECK_TEXT.identityMatched(identity.product.product_name, identity.product.manufacturer ?? identity.product.brand_name) }
      : { status: "not_checked" as const, ...MEDICINE_CHECK_TEXT.identityNotFound }),
  });

  // ── Registration ──────────────────────────────────────────────────────────
  const regNoSource = printed?.drapRegNo ?? identity.product?.drap_reg_no ?? null;
  const lookup = await lookupRegistration(regNoSource);
  const regNo = lookup.record?.reg_no ?? (regNoSource ? regNoSource.replace(/D/g, "").padStart(6, "0") : null);
  for (const s of lookup.sourcesConsulted) sources.add(s === "drap_registry" ? "DRAP registry" : "DRAP price index");
  let registrationMismatch = false;
  let registrationCheck: MedicineCheck;
  if (!regNoSource || lookup.status === "not_checked") {
    registrationCheck = { id: "registration", status: "not_checked", ...MEDICINE_CHECK_TEXT.registrationNotVisible };
  } else if (lookup.status === "found" && lookup.record) {
    const r = lookup.record;
    const productName = printed?.brandName ?? identity.product?.product_name ?? null;
    const company = printed?.manufacturer ?? identity.product?.manufacturer ?? null;
    const strength = printed?.strength ?? identity.product?.strength ?? null;
    // Only an explicit contradiction counts; unknown on either side does not.
    registrationMismatch =
      brandsMatch(r.brand_name, productName) === false ||
      companiesMatch(r.company, company) === false ||
      strengthsOverlap(r.strength ?? r.generic_name, strength) === false;
    registrationCheck = {
      id: "registration",
      status: registrationMismatch ? "fail" : "pass",
      ...(registrationMismatch
        ? MEDICINE_CHECK_TEXT.registrationMismatch(r.reg_no, r.brand_name, r.company)
        : MEDICINE_CHECK_TEXT.registrationFound(r.reg_no, r.brand_name, r.company)),
    };
  } else if (lookup.status === "not_found" && lookup.definitiveNotFound) {
    registrationMismatch = true;
    registrationCheck = { id: "registration", status: "fail", ...MEDICINE_CHECK_TEXT.registrationNotFound(regNo ?? regNoSource) };
  } else if (lookup.status === "not_found") {
    registrationCheck = { id: "registration", status: "not_checked", ...MEDICINE_CHECK_TEXT.registrationNotInPriceList(regNo ?? regNoSource) };
  } else {
    registrationCheck = { id: "registration", status: "not_checked", ...MEDICINE_CHECK_TEXT.registrationUnavailable };
  }
  checks.push(registrationCheck);

  // ── Code consistency (+ GTIN company prefix) ──────────────────────────────
  const consistency = checkCodeConsistency(gs1, printed);
  const gtin = gs1?.valid ? gs1.gtin : input.productCode ?? null;
  if (gtin && consistency.check.status !== "fail") {
    // brandRouter's GS1 prefix index: the company whose catalog SKUs
    // exclusively use this prefix. Compared on the National-style "explicit
    // contradiction only" rule — an unknown prefix proves nothing.
    const owner = await prefixOwner(gtin.length === 14 && gtin.startsWith("0") ? gtin.slice(1) : gtin);
    const company = printed?.manufacturer ?? identity.product?.manufacturer ?? null;
    if (owner && company && companiesMatch(owner, company) === false) {
      consistency.check = { id: "code_consistency", status: "fail", ...MEDICINE_CHECK_TEXT.gtinPrefixMismatch(owner, company) };
      consistency.mismatch = true;
    }
  }
  checks.push(consistency.check);

  // Only a structurally valid code is worth recording — an invalid GTIN is
  // already a failure above, and recording it would let junk pollute counts.
  let serial = NO_SERIAL;
  if (gs1?.gtin && gs1.serial && gs1.valid) {
    const recorded = await recordSerial(gs1.gtin, gs1.serial, gs1.batch, input.reporterKey, input.area);
    serial = recorded ?? NO_SERIAL;
    checks.push({
      id: "duplicate_serial",
      ...(!recorded
        ? { status: "not_checked" as const, ...MEDICINE_CHECK_TEXT.serialUnavailable }
        : recorded.duplicate
          ? {
              status: "fail" as const,
              ...((recorded.distinctAreas ?? 0) >= DUPLICATE_MIN_AREAS
                ? MEDICINE_CHECK_TEXT.serialDuplicateAreas(recorded.distinctAreas ?? 0)
                : MEDICINE_CHECK_TEXT.serialDuplicatePeople(recorded.distinctReporters ?? 0)),
            }
          : { status: "pass" as const, ...MEDICINE_CHECK_TEXT.serialOk(recorded.totalScans ?? 1) }),
    });
  } else {
    checks.push({ id: "duplicate_serial", status: "not_checked", ...MEDICINE_CHECK_TEXT.serialMissing });
  }

  return {
    printed,
    gs1,
    expiry,
    codeMismatch: consistency.mismatch,
    serial,
    identity,
    registration: { ...lookup, regNo },
    registrationMismatch,
    sourcesConsulted: [...sources],
    checks,
  };
}
