/**
 * lib/pharmaText.ts
 *
 * Small, pure text helpers shared by the pharma catalog adapters, the DRAP
 * parsers and the medicine checks. Every function returns null rather than
 * guessing.
 */

const STRENGTH_RE =
  /\b\d+(?:\.\d+)?\s?(?:mg|mcg|µg|g|ml|iu|i\.u\.|%)(?:\s?\/\s?\d*(?:\.\d+)?\s?(?:mg|ml|g|dose|tab))?/gi;

/** "Panadol 500mg Tablet" -> "500 mg"; "Augmentin 625 mg / 5 ml" keeps the ratio. */
export function extractStrength(text: string | null | undefined): string | null {
  if (!text) return null;
  const matches = text.match(STRENGTH_RE);
  if (!matches) return null;
  const unique = [...new Set(matches.map(normaliseStrength))];
  return unique.slice(0, 3).join(" + ");
}

/** Canonical spacing/case so "500MG", "500 mg" and "500mg" compare equal. */
export function normaliseStrength(s: string): string {
  return s
    .toLowerCase()
    .replace(/i\.u\./g, "iu")
    .replace(/\s+/g, "")
    .replace(/(\d)(mg|mcg|µg|g|ml|iu|%)/g, "$1 $2")
    .replace(/\//g, " / ")
    .trim();
}

/** Two strength strings share at least one component ("500 mg" vs "250 mg + 500 mg"). */
export function strengthsOverlap(a: string | null | undefined, b: string | null | undefined): boolean | null {
  if (!a || !b) return null;
  const parts = (s: string) => new Set((s.match(STRENGTH_RE) ?? []).map(normaliseStrength));
  const pa = parts(a);
  const pb = parts(b);
  if (!pa.size || !pb.size) return null;
  for (const p of pa) if (pb.has(p)) return true;
  return false;
}

const DOSAGE_FORMS: [RegExp, string][] = [
  [/\btab(?:let)?s?\b|\bcaplets?\b/i, "Tablet"],
  [/\bcap(?:sule)?s?\b/i, "Capsule"],
  [/\bsyrup\b/i, "Syrup"],
  [/\bsuspension\b/i, "Suspension"],
  [/\b(?:oral\s+)?drops\b/i, "Drops"],
  [/\binjection\b|\binj\.?\b|\binfusion\b|\bvial\b/i, "Injection"],
  [/\bcream\b/i, "Cream"],
  [/\bointment\b/i, "Ointment"],
  [/\bgel\b/i, "Gel"],
  [/\binhaler\b/i, "Inhaler"],
  [/\bsachets?\b/i, "Sachet"],
  [/\belixir\b/i, "Elixir"],
  [/\blotion\b/i, "Lotion"],
];

export function extractDosageForm(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const [re, form] of DOSAGE_FORMS) if (re.test(text)) return form;
  return null;
}

/** Words every pharma company name carries; ignored when comparing names. */
const COMPANY_NOISE =
  /\b(pharma(?:ceuticals?)?|laborator(?:y|ies)|labs?|limited|ltd|pvt|private|pakistan|company|co|inc|international|industries|\(pvt\.?\))\b/gi;

export function normaliseCompany(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(COMPANY_NOISE, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return n || null;
}

/**
 * Same company? Compared on the first distinctive word ("getz", "agp",
 * "sami"), because packs and registries spell the legal suffix differently.
 * Null when either side is unknown — never "different" on missing data.
 */
export function companiesMatch(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const na = normaliseCompany(a);
  const nb = normaliseCompany(b);
  if (!na || !nb) return null;
  const first = (s: string) => s.split(" ")[0];
  return na.includes(first(nb)) || nb.includes(first(na));
}

/** Brand names compared on their first word, case- and symbol-insensitive ("Panadol Extra" ~ "PANADOL"). */
export function brandsMatch(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const clean = (s: string | null | undefined) =>
    s ? s.toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9 ]/g, " ").trim().split(/\s+/)[0] || null : null;
  const ca = clean(a);
  const cb = clean(b);
  if (!ca || !cb) return null;
  return ca === cb;
}

/**
 * DRAP registration numbers are 6 digits, zero-padded ("000817"). Packs print
 * "Reg. No. 012345" or "Reg No: 12345". Null for anything that isn't one.
 */
export function normaliseRegNo(text: string | null | undefined): string | null {
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 6) return null;
  return digits.padStart(6, "0");
}
