/**
 * services/medicineData.ts
 *
 * The database / registry reads behind services/medicineChecks.ts, over the
 * Supabase REST API like the rest of the app. Every read has its own timeout
 * and throws on failure — runMedicineChecks() turns a throw into a skipped
 * check, so a missing table (medicine_patch.sql not run yet) only means the
 * check is skipped, never a failed scan.
 */

import type { DrapAlertRow, MedicineDataSource, MedicineEntry, PriorSerialScan, RegistryStatus } from "./medicineChecks";
import { lookupRegistration } from "./drapLookup";

const READ_TIMEOUT_MS = 3000;
const REGISTRY_TIMEOUT_MS = 3000;

function rest(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Service role when available (server-only); the anon key otherwise — the
  // Medicine and DrapAlert tables are public reference data, readable by anon.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

async function get<T>(path: string): Promise<T[]> {
  const cfg = rest();
  if (!cfg) throw new Error("Supabase not configured");
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${path.split("?")[0]} read returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T[];
}

type MedicineRow = Omit<MedicineEntry, "source">;
const MEDICINE_COLUMNS = "id,gtin,registration_no,brand_name,generic_name,strength,dosage_form,manufacturer";

/** First distinctive word, safe inside a PostgREST filter. */
function filterWord(name: string): string | null {
  const word = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/)[0];
  return word && word.length >= 3 ? word : null;
}

export const supabaseMedicineData: MedicineDataSource = {
  async priorSerialScans(barcode, serial) {
    const rows = await get<PriorSerialScan & { reporter: string | null }>(
      `Scan?barcode=eq.${encodeURIComponent(barcode)}&gs1_serial=eq.${encodeURIComponent(serial)}` +
        `&select=id,area_name,latitude,longitude,customer_id,created_at,reporter:ocr_raw_json->>medicine_reporter` +
        `&order=created_at.desc&limit=100`
    );
    return rows;
  },

  async medicineByRegNo(regNo) {
    const rows = await get<MedicineRow>(`Medicine?registration_no=eq.${encodeURIComponent(regNo)}&select=${MEDICINE_COLUMNS}&limit=1`).catch(
      (err) => {
        // A missing Medicine table falls through to the DRAP cache below.
        console.warn("[Medicine] Medicine table read failed:", err instanceof Error ? err.message : err);
        return [] as MedicineRow[];
      }
    );
    if (rows[0]) return { ...rows[0], source: "Medicine" };

    // The DRAP price-index cache (DrapRegistration) is also "our DRAP list".
    const lookup = await lookupRegistration(regNo);
    if (lookup.status === "found" && lookup.record) {
      const r = lookup.record;
      return {
        id: null,
        gtin: null,
        registration_no: r.reg_no,
        brand_name: r.brand_name,
        generic_name: r.generic_name ?? null,
        strength: r.strength ?? null,
        dosage_form: r.dosage_form ?? null,
        manufacturer: r.company ?? null,
        source: "DrapRegistration",
      };
    }
    if (lookup.status === "unavailable") throw new Error("DRAP list unavailable");
    return null;
  },

  async medicineByGtin(gtin) {
    const rows = await get<MedicineRow>(`Medicine?gtin=eq.${encodeURIComponent(gtin)}&select=${MEDICINE_COLUMNS}&limit=1`);
    return rows[0] ? { ...rows[0], source: "Medicine" } : null;
  },

  async drapAlerts(productName, batchNorm) {
    const word = filterWord(productName);
    const filters = [batchNorm ? `batch_norm.eq.${batchNorm}` : null, word ? `product_name.ilike.*${word}*` : null].filter(Boolean);
    if (!filters.length) return [];
    return get<DrapAlertRow>(
      `DrapAlert?or=(${filters.join(",")})` +
        `&select=product_name,generic_name,batch_no,batch_norm,manufacturer_claimed,alert_type,alert_date,source_url&limit=50`
    );
  },

  /**
   * Optional external serial registry (GS1 Pakistan / DRAP track-and-trace).
   * Never called unless both GS1_VERIFY_API_KEY and DRAP_TT_API_URL are set.
   * Expected contract: POST {gtin, serial, batch, expiry} with a bearer key,
   * answering {"status": "valid" | "invalid" | "unknown"}.
   */
  async gs1Registry(code) {
    const apiKey = process.env.GS1_VERIFY_API_KEY;
    const apiUrl = process.env.DRAP_TT_API_URL;
    if (!apiKey || !apiUrl) return null;
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(code),
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`registry returned ${res.status}`);
    const body = (await res.json()) as { status?: string };
    const status = body?.status;
    return status === "valid" || status === "invalid" ? (status as RegistryStatus) : "unknown";
  },
};

/**
 * Is this GTIN in the Medicine table? Used for routing (detection rule b).
 * Never throws — any failure answers "no", which keeps the existing path.
 */
export async function isCatalogMedicineGtin(gtin14: string | null): Promise<boolean> {
  if (!gtin14) return false;
  try {
    return !!(await supabaseMedicineData.medicineByGtin(gtin14));
  } catch (err) {
    console.warn("[Medicine] catalog GTIN lookup failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
