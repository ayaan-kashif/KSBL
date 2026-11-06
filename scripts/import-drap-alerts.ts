/**
 * npm run alerts:import [path/to/drap-alerts.csv]
 *
 * Loads DRAP falsified / substandard / recall alerts (DrapAlert table) from a
 * CSV with the columns
 *   product_name, generic_name, batch_no, manufacturer_claimed, alert_type, alert_date, source_url
 * Default file: data/drap-alerts.csv. Idempotent: rows are keyed on
 * (batch_norm, product_name), where batch_norm is the batch normalised exactly
 * as the scan-time check compares it (uppercase, no spaces/-//, O→0 I→1 S→5).
 *
 * alert_type must be falsified | substandard | recall; alert_date YYYY-MM-DD.
 * Use source_url "demo" for test rows. Needs prisma/sql/medicine_patch.sql.
 */

import { readCsv, rest, orNull, printCounts } from "./lib/medicineImport";
import { normaliseBatch } from "../src/lib/medicineNormalise";

type AlertRow = {
  id?: string;
  product_name: string;
  generic_name: string | null;
  batch_no: string;
  batch_norm: string;
  manufacturer_claimed: string | null;
  alert_type: string;
  alert_date: string;
  source_url: string;
};

const TYPES = new Set(["falsified", "substandard", "recall"]);
const FIELDS: (keyof AlertRow)[] = ["generic_name", "batch_no", "manufacturer_claimed", "alert_type", "alert_date", "source_url"];

async function main() {
  const file = process.argv[2] ?? "data/drap-alerts.csv";
  const rows = readCsv(file);
  const counts = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const [index, raw] of rows.entries()) {
    const line = index + 2;
    const product = orNull(raw.product_name);
    const batch = orNull(raw.batch_no);
    const batchNorm = normaliseBatch(batch);
    const type = (orNull(raw.alert_type) ?? "").toLowerCase();
    const date = orNull(raw.alert_date);
    const source = orNull(raw.source_url);

    const problem = !product
      ? "missing product_name"
      : !batch || !batchNorm
        ? "missing batch_no"
        : !TYPES.has(type)
          ? `alert_type "${raw.alert_type}" is not falsified/substandard/recall`
          : !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))
            ? `alert_date "${raw.alert_date}" is not YYYY-MM-DD`
            : !source
              ? "missing source_url (use \"demo\" for test rows)"
              : null;
    if (problem) {
      console.warn(`  line ${line}: skipped — ${problem}`);
      counts.skipped++;
      continue;
    }

    const record: AlertRow = {
      product_name: product!,
      generic_name: orNull(raw.generic_name),
      batch_no: batch!,
      batch_norm: batchNorm!,
      manufacturer_claimed: orNull(raw.manufacturer_claimed),
      alert_type: type,
      alert_date: date!,
      source_url: source!,
    };

    const existing = (
      await rest<AlertRow[]>(
        "GET",
        `DrapAlert?batch_norm=eq.${encodeURIComponent(batchNorm!)}&product_name=eq.${encodeURIComponent(product!)}&select=*&limit=1`
      )
    )[0];

    if (!existing) {
      await rest("POST", "DrapAlert", record);
      counts.inserted++;
    } else if (FIELDS.some((f) => (existing[f] ?? null) !== (record[f] ?? null))) {
      await rest("PATCH", `DrapAlert?id=eq.${existing.id}`, record);
      counts.updated++;
    } else {
      counts.unchanged++;
    }
  }

  printCounts(`DrapAlert (${file})`, counts);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
