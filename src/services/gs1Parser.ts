/**
 * services/gs1Parser.ts
 *
 * Parses GS1 element strings out of a decoded DataMatrix / QR / GS1-128
 * payload. DRAP requires a 2D GS1 DataMatrix carrying a serial number on
 * registered medicines made from Oct 9, 2026; older packs are exempt and carry
 * a linear barcode or nothing — callers must handle both, so a payload that
 * isn't GS1 simply returns `isGs1: false`.
 *
 * Accepts every form the decoder can hand over:
 *  - human-readable "(01)08901234567896(17)271231(10)AB12" (ZXing's default
 *    HRI text mode)
 *  - raw element strings with FNC1 rendered as the GS separator (\x1D)
 *  - either of those behind a symbology identifier ("]d2", "]Q3", "]C1")
 *
 * Extracts (01) GTIN, (10) batch/lot, (11) manufacturing date, (17) expiry
 * and (21) serial; every other AI is kept in `raw`. Never throws.
 */

import { isValidGs1CheckDigit } from "./barcodeDecoder";

export interface Gs1Data {
  /** The payload was recognised as GS1 element strings at all. */
  isGs1: boolean;
  gtin: string | null;
  batch: string | null;
  /** ISO date (YYYY-MM-DD) from AI (11). */
  mfgDate: string | null;
  /** ISO date (YYYY-MM-DD) from AI (17); DD=00 means the last day of the month. */
  expiry: string | null;
  serial: string | null;
  /** Every AI found, keyed by AI, including the ones above. */
  raw: Record<string, string>;
  /** GS1 parsed, the GTIN check digit (if any) is correct and dates are real dates. */
  valid: boolean;
}

const GS = "\x1D";

/** AIs whose data length is fixed (data only, AI excluded). GS1 General Specifications fig. 5.10.1-2. */
const FIXED_2: Record<string, number> = {
  "00": 18, "01": 14, "02": 14, "03": 14, "04": 16,
  "11": 6, "12": 6, "13": 6, "14": 6, "15": 6, "16": 6, "17": 6, "18": 6, "19": 6,
  "20": 2,
};
/** Two-digit AIs with variable-length data, terminated by GS or end of string. */
const VARIABLE_2 = new Set(["10", "21", "22", "30", "37", "90", "91", "92", "93", "94", "95", "96", "97", "98", "99"]);
/** Prefixes of four-digit AIs with fixed 6-digit data (measures: 31nn–36nn). */
const FIXED_4_PREFIXES = new Set(["31", "32", "33", "34", "35", "36"]);
/** Prefixes of three-digit AIs with variable data. "41" (41n) is fixed 13. */
const VARIABLE_3_PREFIXES = new Set(["23", "24", "25", "40", "42", "71", "72"]);
/** Prefixes of four-digit AIs with variable data. */
const VARIABLE_4_PREFIXES = new Set(["39", "70", "80", "81", "82"]);

const EMPTY: Gs1Data = {
  isGs1: false,
  gtin: null,
  batch: null,
  mfgDate: null,
  expiry: null,
  serial: null,
  raw: {},
  valid: false,
};

/** Human-readable form: "(01)0890…(17)271231(10)AB12". */
function parseHumanReadable(text: string): Record<string, string> | null {
  if (!/^\(\d{2,4}\)/.test(text)) return null;
  const raw: Record<string, string> = {};
  for (const match of text.matchAll(/\((\d{2,4})\)([^(]*)/g)) {
    raw[match[1]] = match[2].replace(new RegExp(GS, "g"), "").trim();
  }
  return Object.keys(raw).length ? raw : null;
}

/** Raw element strings with GS separators: "0108901234567896172712311" + "0AB12". */
function parseElementString(text: string): Record<string, string> | null {
  const raw: Record<string, string> = {};
  let i = 0;
  const readVariable = (start: number): [string, number] => {
    const end = text.indexOf(GS, start);
    return end === -1 ? [text.slice(start), text.length] : [text.slice(start, end), end + 1];
  };

  while (i < text.length) {
    if (text[i] === GS) {
      i++;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (!/^\d{2}$/.test(two)) return null;

    let ai: string;
    let value: string;
    if (two in FIXED_2) {
      ai = two;
      value = text.slice(i + 2, i + 2 + FIXED_2[two]);
      if (value.length !== FIXED_2[two]) return null;
      i += 2 + FIXED_2[two];
    } else if (VARIABLE_2.has(two)) {
      ai = two;
      [value, i] = readVariable(i + 2);
    } else if (FIXED_4_PREFIXES.has(two)) {
      ai = text.slice(i, i + 4);
      value = text.slice(i + 4, i + 10);
      if (value.length !== 6) return null;
      i += 10;
    } else if (two === "41") {
      ai = text.slice(i, i + 3);
      value = text.slice(i + 3, i + 16);
      if (value.length !== 13) return null;
      i += 16;
    } else if (VARIABLE_3_PREFIXES.has(two)) {
      ai = text.slice(i, i + 3);
      [value, i] = readVariable(i + 3);
    } else if (VARIABLE_4_PREFIXES.has(two)) {
      ai = text.slice(i, i + 4);
      [value, i] = readVariable(i + 4);
    } else {
      // Unknown AI: keep what's left rather than guessing its length.
      raw["?"] = text.slice(i);
      break;
    }
    raw[ai] = value;
  }
  return Object.keys(raw).length ? raw : null;
}

/**
 * GS1 YYMMDD → ISO date. Century per GS1 §7.12: a year more than 50 years
 * ahead of today belongs to the previous century. DD "00" means the last day
 * of the month (used for expiry). Returns null for an impossible date.
 */
function parseGs1Date(value: string | undefined, today = new Date()): string | null {
  if (!value || !/^\d{6}$/.test(value)) return null;
  const yy = Number(value.slice(0, 2));
  const mm = Number(value.slice(2, 4));
  let dd = Number(value.slice(4, 6));
  if (mm < 1 || mm > 12) return null;

  const currentYear = today.getUTCFullYear();
  let year = 2000 + yy;
  if (year - currentYear > 50) year -= 100;
  else if (currentYear - year > 49) year += 100;

  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  if (dd === 0) dd = lastDay;
  if (dd > lastDay) return null;
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

export function parseGs1(payload: string | null | undefined, symbologyIdentifier?: string | null): Gs1Data {
  try {
    if (!payload) return EMPTY;
    let text = payload.trim();

    // "]d2" GS1 DataMatrix, "]Q3" GS1 QR, "]C1" GS1-128, "]e0" GS1 DataBar.
    const prefixed = text.match(/^\](d2|Q3|C1|e0|J1)/);
    if (prefixed) text = text.slice(3);
    const declaredGs1 = !!prefixed || /^\](d2|Q3|C1|e0|J1)$/.test(symbologyIdentifier ?? "");
    if (text.startsWith(GS)) text = text.slice(1);

    const raw = parseHumanReadable(text) ?? (declaredGs1 || text.includes(GS) ? parseElementString(text) : null);
    if (!raw) return EMPTY;

    const gtin = raw["01"] ?? null;
    const mfgRaw = raw["11"];
    const expRaw = raw["17"];
    const mfgDate = parseGs1Date(mfgRaw);
    const expiry = parseGs1Date(expRaw);

    const gtinOk = gtin === null || (/^\d{14}$/.test(gtin) && isValidGs1CheckDigit(gtin));
    const datesOk = (mfgRaw === undefined || mfgDate !== null) && (expRaw === undefined || expiry !== null);

    return {
      isGs1: true,
      gtin,
      batch: raw["10"] || null,
      mfgDate,
      expiry,
      serial: raw["21"] || null,
      raw,
      valid: gtinOk && datesOk && !("?" in raw),
    };
  } catch (err) {
    console.error("[GS1Parser] Failed to parse payload:", err);
    return EMPTY;
  }
}

/**
 * A GS1 code that marks the pack as a medicine: a GTIN plus at least one of
 * batch, expiry or serial — the combination DRAP's DataMatrix rule mandates.
 */
/**
 * The conservative medicine signal: a GS1 code carrying BOTH a serial (21)
 * and an expiry (17) — the DRAP serialisation format. Food GS1 codes carry
 * batch and best-before, but not unit serial numbers. Used for routing; the
 * GTIN check digit is judged separately by the checks, so a fake code with a
 * bad check digit still reaches the medicine path and fails there.
 */
export function isSerialisedMedicineGs1(data: Gs1Data | null | undefined): boolean {
  return !!data?.isGs1 && !!data.gtin && !!data.serial && !!data.expiry;
}

export function isMedicineGs1(data: Gs1Data): boolean {
  return data.isGs1 && !!data.gtin && !!(data.batch || data.expiry || data.serial);
}
