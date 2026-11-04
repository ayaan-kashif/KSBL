/**
 * GET|POST /api/scraper/drap?start=1&pages=40
 *
 * Crawls DRAP's public Pharmaceutical Product Price Index
 * (https://e.dra.gov.pk/public/price) into the DrapRegistration cache, which
 * the medicine scan path reads instead of calling DRAP live — see
 * src/services/drapLookup.ts for why this source and not the registry.
 *
 * The index is ~1,090 pages of 20 rows, too many for one serverless run at a
 * polite rate, so each call crawls a window: `start` (1-based page) and
 * `pages` (max 60). The response's `next_start` is the next window; it is
 * null once the last page is done. Same auth, robots, delay and ScrapeRun
 * conventions as the other scrapers (lib/scrapeSupport.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_USER_AGENT,
  checkCronAuth,
  createScrapeRun,
  finishScrapeRun,
  politeFetch,
  serviceConfig,
  sleep,
  upsertRows,
} from "@/lib/scrapeSupport";
import { DRAP_PRICE_INDEX_URL, parsePriceIndexPage, priceIndexLastPage } from "@/services/drapLookup";

export const runtime = "nodejs";
export const maxDuration = 300;

const REQUEST_DELAY_MS = 2000;
const MAX_PAGES_PER_RUN = 60;

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  const unauthorized = checkCronAuth(req);
  if (unauthorized) return unauthorized;
  const config = serviceConfig();
  if (!config) return NextResponse.json({ error: "Supabase service-role configuration missing" }, { status: 500 });

  const start = Math.max(1, Number(req.nextUrl.searchParams.get("start")) || 1);
  const pages = Math.min(MAX_PAGES_PER_RUN, Math.max(1, Number(req.nextUrl.searchParams.get("pages")) || 40));
  const userAgent = process.env.SCRAPER_USER_AGENT ?? DEFAULT_USER_AGENT;
  const runId = await createScrapeRun(config.supabaseUrl, config.serviceKey, "drap_price_index");

  let lastPage: number | null = null;
  let found = 0;
  let upserted = 0;
  let failed = 0;
  let page = start;
  const errors: { page: number; error: string }[] = [];

  for (; page < start + pages; page++) {
    if (lastPage !== null && page > lastPage) break;
    const url = `${DRAP_PRICE_INDEX_URL}?page=${page}`;
    try {
      if (page > start) await sleep(REQUEST_DELAY_MS);
      const html = await (await politeFetch(url, userAgent)).text();
      lastPage ??= priceIndexLastPage(html);
      const records = parsePriceIndexPage(html, url);
      found += records.length;
      if (!records.length) continue;

      // One registration number can appear once per pack size; an upsert batch
      // may not touch the same key twice, so keep the last row per number.
      const byRegNo = new Map(records.map((r) => [r.reg_no, r]));
      const fetchedAt = new Date().toISOString();
      const rows = [...byRegNo.values()].map((r) => ({ ...r, fetched_at: fetchedAt, raw: { page } }));
      upserted += (await upsertRows(config.supabaseUrl, config.serviceKey, "DrapRegistration", "reg_no", rows)).length;
    } catch (err) {
      failed++;
      errors.push({ page, error: String(err) });
      console.error(`[DrapScraper] page ${page} failed:`, err);
    }
  }

  const status = failed === 0 ? "success" : upserted > 0 ? "partial_failure" : "failed";
  const nextStart = lastPage !== null && page > lastPage ? null : page;
  await finishScrapeRun(config.supabaseUrl, config.serviceKey, runId, {
    status,
    products_found: found,
    products_created: upserted,
    products_failed: failed,
    error_log: { window: [start, page - 1], last_page: lastPage, next_start: nextStart, errors },
  });

  return NextResponse.json({
    run_id: runId,
    status,
    pages_crawled: [start, page - 1],
    last_page: lastPage,
    next_start: nextStart,
    rows_found: found,
    registrations_upserted: upserted,
    pages_failed: failed,
    errors,
  });
}
