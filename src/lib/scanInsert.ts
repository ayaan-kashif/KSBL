/**
 * lib/scanInsert.ts
 *
 * POST a Scan row over Supabase REST, with optional medicine-only columns
 * (product_type, gs1_serial, gs1_expiry, gs1_batch, registration_no) from
 * prisma/sql/medicine_patch.sql.
 *
 * Food/FMCG scans pass no extra columns, so their request is exactly what it
 * was before. A medicine scan made before the patch has run would fail on the
 * unknown columns ("Could not find the 'gs1_serial' column", PGRST204), so it
 * is retried once without them — the scan is always recorded.
 */

import { MEDICINE_LOG } from "./medicineConfig";

export async function postScanRow(
  supabaseUrl: string,
  apiKey: string,
  row: Record<string, unknown>,
  medicineColumns: Record<string, unknown> | null
): Promise<Response> {
  const send = (body: Record<string, unknown>) =>
    fetch(`${supabaseUrl}/rest/v1/Scan`, {
      method: "POST",
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(body),
    });

  if (!medicineColumns) return send(row);

  const res = await send({ ...row, ...medicineColumns });
  if (res.ok || res.status !== 400) return res;

  const text = await res.clone().text();
  if (!/PGRST204|column/i.test(text)) return res;
  console.warn(`${MEDICINE_LOG} Scan medicine columns missing (run prisma/sql/medicine_patch.sql) — saving without them`);
  return send(row);
}
