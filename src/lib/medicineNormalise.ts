/**
 * lib/medicineNormalise.ts
 *
 * Pure normalisers shared by the medicine checks (services/medicineChecks.ts)
 * and the CSV import scripts, so a batch or GTIN is stored exactly the way the
 * checks later compare it. No I/O, no heavy imports.
 */

/**
 * Batch codes as compared: uppercase, no spaces / "-" / "/" / ".", and the
 * look-alike letters a photo misreads folded onto digits (O→0, I→1, S→5).
 */
export function normaliseBatch(batch: string | null | undefined): string | null {
  if (!batch) return null;
  const n = batch.toUpperCase().replace(/[\s\-/.]/g, "").replace(/O/g, "0").replace(/I/g, "1").replace(/S/g, "5");
  return n || null;
}

/** GTIN-8/12/13/14 → GTIN-14, the form the Medicine table stores. */
export function gtin14(code: string | null | undefined): string | null {
  const digits = (code ?? "").trim();
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return null;
  return digits.padStart(14, "0");
}

/** GS1 mod-10 check digit of a GTIN of any length (8/12/13/14). */
export function isValidGtin(code: string | null | undefined): boolean {
  const g = gtin14(code);
  if (!g) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(g[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(g[13]);
}
