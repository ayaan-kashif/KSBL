/**
 * lib/medicineConfig.ts
 *
 * Kill switch and tunables for medicine verification. Everything medicine-
 * specific checks medicineVerificationEnabled() first, so with
 * MEDICINE_VERIFICATION_ENABLED=false no medicine code runs at all: no extra
 * prompt fields, no back-of-pack DataMatrix decode, no medicine routing, and
 * every scan goes down national_rag / external_db as before.
 */

/** On unless explicitly turned off ("false", "0", "off", "no"). */
export function medicineVerificationEnabled(): boolean {
  const raw = (process.env.MEDICINE_VERIFICATION_ENABLED ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(raw);
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Same serial seen further apart than this is a copied code. */
export function cloneDistanceKm(): number {
  return positiveNumber(process.env.MEDICINE_CLONE_DISTANCE_KM, 20);
}

/** More scans than this of one serial in one area is a warning. */
export function cloneMaxScans(): number {
  return positiveNumber(process.env.MEDICINE_CLONE_MAX_SCANS, 3);
}

/** Every medicine log line starts with this, so they can be filtered. */
export const MEDICINE_LOG = "[Medicine]";
