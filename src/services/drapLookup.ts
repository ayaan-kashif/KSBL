/**
 * services/drapLookup.ts
 *
 * DRAP registration data, from public pages only — DRAP publishes no API.
 *
 *  1. Pharmaceutical Product Price Index (e.dra.gov.pk/public/price) —
 *     robots.txt allows everything and no restrictive notice was found
 *     (checked 2026-11-03). /api/scraper/drap crawls it into the
 *     DrapRegistration table. It lists PRICED products, not every registered
 *     medicine, so a number missing from it proves nothing.
 *  2. Registered drugs index (eapp.dra.gov.pk/WebProductIndex.php) — the
 *     actual registry, open to plain HTTP, but its disclaimer says the list
 *     "cannot be used as a reference for any purpose" and is only for
 *     stakeholders reviewing their own products. The adapter below is ready
 *     but OFF unless DRAP_REGISTRY_LOOKUP_ENABLED=true, which should only be
 *     set with DRAP's permission.
 *
 * The DRAP Track & Trace portal is deliberately not used: pack-level
 * verification needs DRAP authorization.
 *
 * Scan-time lookups read the cache table only (plus the registry adapter
 * when enabled), with timeouts. A DRAP outage never breaks a scan.
 */

import { load } from "cheerio";
import { extractDosageForm, extractStrength, normaliseRegNo } from "@/lib/pharmaText";

export const DRAP_PRICE_INDEX_URL = "https://e.dra.gov.pk/public/price";
const DRAP_REGISTRY_URL = "https://eapp.dra.gov.pk/productView.php";
const REGISTRY_TIMEOUT_MS = 5000;
const CACHE_TIMEOUT_MS = 4000;

export interface DrapRecord {
  reg_no: string;
  brand_name: string;
  generic_name: string | null;
  strength: string | null;
  dosage_form: string | null;
  company: string | null;
  status: string | null;
  pack_size: string | null;
  mrp_pkr: number | null;
  source: "drap_price_index" | "drap_registry";
  source_url: string | null;
}

// ─── Parsers ────────────────────────────────────────────────────────────────

/**
 * One page of the price index: a table whose rows are
 * name+composition | reg no | manufacturer+licence | category | pack | price | effective date.
 */
export function parsePriceIndexPage(html: string, pageUrl: string): DrapRecord[] {
  const $ = load(html);
  const records: DrapRecord[] = [];
  $("tbody tr").each((_, tr) => {
    const td = $(tr).find("td");
    if (td.length < 6) return;
    const nameLines = $(td[0]).find(".ml-4 > div");
    const name = $(nameLines[0]).text().replace(/\s+/g, " ").trim();
    const composition = $(nameLines[1]).text().replace(/\s+/g, " ").trim() || null;
    const regNo = normaliseRegNo($(td[1]).text());
    if (!name || !regNo) return;
    const priceText = $(td[5]).text().replace(/[^\d.]/g, "");
    records.push({
      reg_no: regNo,
      brand_name: name,
      generic_name: composition,
      strength: extractStrength(name) ?? extractStrength(composition),
      dosage_form: extractDosageForm(name) ?? extractDosageForm(composition),
      company: $(td[2]).find("div").first().text().replace(/\s+/g, " ").trim() || null,
      status: null,
      pack_size: $(td[4]).text().replace(/\s+/g, " ").trim() || null,
      mrp_pkr: priceText ? Number(priceText) : null,
      source: "drap_price_index",
      source_url: pageUrl,
    });
  });
  return records;
}

/** Highest page number linked from a price-index page ("page=1090"). */
export function priceIndexLastPage(html: string): number | null {
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  return pages.length ? Math.max(...pages) : null;
}

/** A registry record ("Product Name … Registration No … Company Name …"). */
export function parseRegistryRecord(html: string, regNo: string): DrapRecord | null {
  const text = load(html).text().replace(/\s+/g, " ");
  const field = (label: string, next: string[]) => {
    const start = text.indexOf(label);
    if (start === -1) return null;
    const from = start + label.length;
    const ends = next.map((n) => text.indexOf(n, from)).filter((i) => i !== -1);
    const value = text.slice(from, ends.length ? Math.min(...ends) : undefined).trim();
    return value || null;
  };
  const labels = ["Product Name", "Registration No", "Registration Date", "Company Name", "Company Address",
    "Registration Status", "Route of Admin", "Used For", "Dosage Form", "Product Specification",
    "Manufacturing Type", "Label Claim", "Container Closure", "Composition", "Pack Size(s)"];
  const get = (label: string) => field(label, labels.filter((l) => l !== label));
  const name = get("Product Name");
  if (!name) return null;
  const composition = get("Composition");
  return {
    reg_no: regNo,
    brand_name: name,
    generic_name: composition,
    strength: extractStrength(composition) ?? extractStrength(name),
    dosage_form: get("Dosage Form") ?? extractDosageForm(name),
    company: get("Company Name"),
    status: get("Registration Status"),
    pack_size: get("Pack Size(s)"),
    mrp_pkr: null,
    source: "drap_registry",
    source_url: `https://eapp.dra.gov.pk/product_view_web.php?reg_no=${regNo}`,
  };
}

// ─── Scan-time lookup ───────────────────────────────────────────────────────

export type DrapLookupStatus = "found" | "not_found" | "unavailable" | "not_checked";

export interface DrapLookupResult {
  status: DrapLookupStatus;
  record: DrapRecord | null;
  /** Which sources were actually consulted — shown as "data sources". */
  sourcesConsulted: ("drap_price_index" | "drap_registry")[];
  /** True only when the authoritative registry said "no such number". */
  definitiveNotFound: boolean;
}

export function registryLookupEnabled(): boolean {
  return process.env.DRAP_REGISTRY_LOOKUP_ENABLED === "true";
}

async function readCache(regNo: string): Promise<DrapRecord | null | "error"> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return "error";
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/DrapRegistration?reg_no=eq.${encodeURIComponent(regNo)}&select=*`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: AbortSignal.timeout(CACHE_TIMEOUT_MS),
    });
    if (!res.ok) return "error";
    const rows = (await res.json()) as DrapRecord[];
    return rows[0] ?? null;
  } catch (err) {
    console.error("[DrapLookup] cache read failed:", err);
    return "error";
  }
}

/** Write-through cache for registry hits. Service role: the table is read-only to anon. */
async function writeCache(record: DrapRecord): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return;
  try {
    await fetch(`${supabaseUrl}/rest/v1/DrapRegistration?on_conflict=reg_no`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ ...record, fetched_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(CACHE_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("[DrapLookup] cache write failed:", err);
  }
}

/** Live registry lookup by registration number. Only called when enabled. */
async function fetchRegistry(regNo: string): Promise<DrapRecord | null | "error"> {
  try {
    const res = await fetch(DRAP_REGISTRY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": process.env.SCRAPER_USER_AGENT ?? "ShelfWatchBot/1.0 (+https://shelfwatch.pk)",
      },
      body: new URLSearchParams({ webRegNo: regNo }).toString(),
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!res.ok) return "error";
    return parseRegistryRecord(await res.text(), regNo);
  } catch (err) {
    console.error("[DrapLookup] registry fetch failed:", err);
    return "error";
  }
}

/**
 * Look a printed registration number up. Brand-name search isn't offered at
 * scan time: without the number, a brand match can't distinguish strengths
 * and packs reliably enough to judge a product on.
 */
export async function lookupRegistration(printedRegNo: string | null | undefined): Promise<DrapLookupResult> {
  const regNo = normaliseRegNo(printedRegNo);
  if (!regNo) return { status: "not_checked", record: null, sourcesConsulted: [], definitiveNotFound: false };

  const sources: DrapLookupResult["sourcesConsulted"] = [];
  const cached = await readCache(regNo);
  if (cached !== "error") sources.push("drap_price_index");
  if (cached && cached !== "error") {
    return { status: "found", record: cached, sourcesConsulted: [cached.source], definitiveNotFound: false };
  }

  if (registryLookupEnabled()) {
    const live = await fetchRegistry(regNo);
    if (live !== "error") {
      sources.push("drap_registry");
      if (live) {
        await writeCache(live);
        return { status: "found", record: live, sourcesConsulted: sources, definitiveNotFound: false };
      }
      return { status: "not_found", record: null, sourcesConsulted: sources, definitiveNotFound: true };
    }
  }

  // Missing from the price index alone is not evidence: it lists priced
  // products, not every registered one.
  return {
    status: cached === "error" ? "unavailable" : "not_found",
    record: null,
    sourcesConsulted: sources,
    definitiveNotFound: false,
  };
}
