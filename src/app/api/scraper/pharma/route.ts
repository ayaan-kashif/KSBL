/**
 * GET|POST /api/scraper/pharma?company=agp&offset=0&limit=25
 *
 * Scrapes the public product catalogs of Pakistani pharma companies into the
 * Product table as category "medicine", so the medicine scan path has
 * reference data and reference images. Sources, URLs and selectors live in
 * src/config/scrapeSources.pharma.json; per-company parsing in
 * src/services/pharmaAdapters.ts.
 *
 * Catalogs run to hundreds of pages, so each call takes a window per company
 * (`offset`, `limit` ≤ max_products_per_run) and reports `next_offset`.
 * `company` limits the run to one company. Embeddings are NOT generated here:
 * run /api/scraper/backfill-embeddings afterwards, which fills every row that
 * has a reference image and no embedding.
 *
 * Same auth, robots, delay and ScrapeRun conventions as the other scrapers.
 * Per-item failures are logged and never abort the run.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { uploadImage } from "@/lib/blob";
import {
  checkCronAuth,
  createScrapeRun,
  finishScrapeRun,
  politeFetch,
  serviceConfig,
  sleep,
  upsertRows,
} from "@/lib/scrapeSupport";
import { PHARMA_ADAPTERS, type PharmaCompanyConfig, type ScrapedMedicine } from "@/services/pharmaAdapters";
import pharmaConfig from "@/config/scrapeSources.pharma.json";

export const runtime = "nodejs";
export const maxDuration = 300;

interface PharmaScrapeConfig {
  user_agent: string;
  request_delay_ms: number;
  max_products_per_run: number;
  companies: PharmaCompanyConfig[];
}

// JSON imports infer per-entry literal types; the shape is checked by the interface above.
const config = pharmaConfig as unknown as PharmaScrapeConfig;

/** Deterministic SKU for catalog rows without a GTIN, so re-runs update instead of duplicating. */
function pharmaSku(companyId: string, name: string, strength: string | null): string {
  const key = `${companyId}:${name}:${strength ?? ""}`;
  const hash = crypto.createHash("sha1").update(key).digest("hex").slice(0, 8).toUpperCase();
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, 24);
  return `RX-${companyId.toUpperCase()}-${slug}-${hash}`;
}

async function storeImage(item: ScrapedMedicine, sku: string, userAgent: string): Promise<string | null> {
  for (const src of item.imageUrls) {
    try {
      const res = await politeFetch(src, userAgent);
      return await uploadImage(`pharma/${sku}.jpg`, await res.blob());
    } catch (err) {
      console.warn(`[PharmaScraper] image ${src} failed:`, err);
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  const unauthorized = checkCronAuth(req);
  if (unauthorized) return unauthorized;
  const service = serviceConfig();
  if (!service) return NextResponse.json({ error: "Supabase service-role configuration missing" }, { status: 500 });

  const only = req.nextUrl.searchParams.get("company");
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get("offset")) || 0);
  const limit = Math.min(
    config.max_products_per_run,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || config.max_products_per_run)
  );
  const userAgent = process.env.SCRAPER_USER_AGENT ?? config.user_agent;

  const results = [];
  for (const company of config.companies) {
    if (only && company.id !== only) continue;
    if (!company.enabled || !company.adapter || !PHARMA_ADAPTERS[company.adapter]) {
      results.push({ company: company.id, skipped: true, reason: company.notes });
      continue;
    }

    const adapter = PHARMA_ADAPTERS[company.adapter];
    const runId = await createScrapeRun(service.supabaseUrl, service.serviceKey, `pharma_scrape:${company.id}`);
    const errors: { item?: string; error: string }[] = [];
    let found = 0;
    let stored = 0;
    let failed = 0;
    let total = 0;
    let nextOffset: number | null = null;

    try {
      const listing = await adapter.list(company, userAgent);
      total = "urls" in listing ? listing.urls.length : listing.items.length;
      const window = "urls" in listing ? listing.urls.slice(offset, offset + limit) : listing.items.slice(offset, offset + limit);
      nextOffset = offset + window.length < total ? offset + window.length : null;

      for (const entry of window) {
        const label = typeof entry === "string" ? entry : entry.productName;
        try {
          await sleep(config.request_delay_ms);
          let item: ScrapedMedicine | null;
          if (typeof entry === "string") {
            const html = await (await politeFetch(entry, userAgent)).text();
            item = adapter.parse ? adapter.parse(html, entry, company) : null;
          } else {
            item = entry;
          }
          if (!item) throw new Error("No product found on page");
          found++;

          const sku = pharmaSku(company.id, item.productName, item.strength);
          const imageUrl = await storeImage(item, sku, userAgent);
          const now = new Date().toISOString();
          await upsertRows(service.supabaseUrl, service.serviceKey, "Product", "sku", [
            {
              sku,
              category: "medicine",
              brand_name: company.name,
              manufacturer: company.name,
              product_name: item.productName,
              generic_name: item.genericName,
              strength: item.strength,
              dosage_form: item.dosageForm,
              reference_image_url: imageUrl,
              // Medicines are never batch-pattern matched (verifyProduct's
              // findProductByBatchPattern); this pattern matches nothing.
              reference_batch_pattern: "(?!)",
              status: "active",
              source: `pharma_scrape:${company.id}`,
              source_url: item.sourceUrl,
              fetched_at: now,
              last_scraped_at: now,
            },
          ]);
          stored++;
        } catch (itemErr) {
          failed++;
          errors.push({ item: label, error: String(itemErr) });
          console.error(`[PharmaScraper] ${company.id} "${label}" failed:`, itemErr);
        }
      }
    } catch (listErr) {
      failed++;
      errors.push({ error: `Listing failed: ${String(listErr)}` });
      console.error(`[PharmaScraper] ${company.id} listing failed:`, listErr);
    }

    const status = failed === 0 ? "success" : stored > 0 ? "partial_failure" : "failed";
    await finishScrapeRun(service.supabaseUrl, service.serviceKey, runId, {
      status,
      products_found: found,
      products_created: stored,
      products_failed: failed,
      error_log: { offset, limit, total, next_offset: nextOffset, errors },
    });
    results.push({ company: company.id, run_id: runId, status, total, offset, found, stored, failed, next_offset: nextOffset, errors });
  }

  return NextResponse.json({ results });
}
