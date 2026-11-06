/**
 * npm run medicines:import [path/to/medicines.csv]
 *
 * Loads the medicine catalogue (Medicine table) from a CSV with the columns
 *   registration_no, brand_name, generic_name, strength, dosage_form, manufacturer, gtin
 * Default file: data/medicines.csv. Idempotent: rows are matched on gtin, then
 * on registration_no, and updated in place; re-running changes nothing.
 *
 * Stored as the checks compare them: gtin as GTIN-14, registration_no as the
 * 6-digit DRAP number. A row is skipped (with the reason printed) when it has
 * no brand_name, a GTIN with a bad check digit, or a malformed Reg. No.
 *
 * Needs prisma/sql/medicine_patch.sql to have been run.
 */

import { readCsv, rest, orNull, printCounts } from "./lib/medicineImport";
import { gtin14, isValidGtin } from "../src/lib/medicineNormalise";
import { normaliseRegNo } from "../src/lib/pharmaText";

type MedicineRow = {
  id?: string;
  gtin: string | null;
  registration_no: string | null;
  brand_name: string;
  generic_name: string | null;
  strength: string | null;
  dosage_form: string | null;
  manufacturer: string | null;
};

const FIELDS: (keyof MedicineRow)[] = ["gtin", "registration_no", "brand_name", "generic_name", "strength", "dosage_form", "manufacturer"];

async function main() {
  const file = process.argv[2] ?? "data/medicines.csv";
  const rows = readCsv(file);
  const counts = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const [index, raw] of rows.entries()) {
    const line = index + 2; // header is line 1
    const brand = orNull(raw.brand_name);
    const rawGtin = orNull(raw.gtin);
    const rawReg = orNull(raw.registration_no);
    const gtin = rawGtin ? gtin14(rawGtin.replace(/\s/g, "")) : null;
    const reg = rawReg ? normaliseRegNo(rawReg) : null;

    const problem = !brand
      ? "missing brand_name"
      : rawGtin && (!gtin || !isValidGtin(gtin))
        ? `GTIN "${rawGtin}" fails the check digit`
        : rawReg && !reg
          ? `Reg. No. "${rawReg}" is not a DRAP number`
          : !gtin && !reg
            ? "needs a gtin or a registration_no"
            : null;
    if (problem) {
      console.warn(`  line ${line}: skipped — ${problem}`);
      counts.skipped++;
      continue;
    }

    const record: MedicineRow = {
      gtin,
      registration_no: reg,
      brand_name: brand!,
      generic_name: orNull(raw.generic_name),
      strength: orNull(raw.strength),
      dosage_form: orNull(raw.dosage_form),
      manufacturer: orNull(raw.manufacturer),
    };

    const existing =
      (gtin ? (await rest<MedicineRow[]>("GET", `Medicine?gtin=eq.${gtin}&select=*&limit=1`))[0] : undefined) ??
      (reg ? (await rest<MedicineRow[]>("GET", `Medicine?registration_no=eq.${reg}&select=*&limit=1`))[0] : undefined);

    if (!existing) {
      await rest("POST", "Medicine", record);
      counts.inserted++;
    } else if (FIELDS.some((f) => (existing[f] ?? null) !== (record[f] ?? null))) {
      await rest("PATCH", `Medicine?id=eq.${existing.id}`, record);
      counts.updated++;
    } else {
      counts.unchanged++;
    }
  }

  printCounts(`Medicine (${file})`, counts);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
