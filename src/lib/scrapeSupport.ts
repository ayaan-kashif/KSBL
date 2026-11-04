/**
 * lib/scrapeSupport.ts
 *
 * Shared plumbing for the pharma and DRAP scrapers (src/app/api/scraper/pharma,
 * src/app/api/scraper/drap). Same conventions as the National Foods scraper:
 * CRON_SECRET bearer auth, robots.txt respected via lib/robots.ts, a fixed
 * delay between requests, an honest User-Agent, and a ScrapeRun row per run
 * for auditability. The National Foods route keeps its own copies untouched.
 */

import { NextRequest, NextResponse } from "next/server";
import { isScrapingAllowed } from "./robots";

export const DEFAULT_USER_AGENT = "ShelfWatchBot/1.0 (+https://shelfwatch.pk)";
const FETCH_TIMEOUT_MS = 20000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same bearer check as the National Foods scraper. Returns a response to send when unauthorized. */
export function checkCronAuth(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export function serviceConfig(): { supabaseUrl: string; serviceKey: string } | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return supabaseUrl && serviceKey ? { supabaseUrl, serviceKey } : null;
}

/** robots.txt-checked GET with a timeout. Throws with a readable message. */
export async function politeFetch(url: string, userAgent: string): Promise<Response> {
  if (!(await isScrapingAllowed(url, userAgent))) throw new Error(`Disallowed by robots.txt: ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

/** <loc> URLs from a sitemap, including CDATA-wrapped ones. */
export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/g)].map((m) => m[1]);
}

export async function createScrapeRun(supabaseUrl: string, serviceKey: string, source: string): Promise<string | null> {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/ScrapeRun`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ source, status: "running" }),
    });
    if (!res.ok) return null;
    return (await res.json())?.[0]?.id ?? null;
  } catch (err) {
    console.error("[Scrape] Failed to create ScrapeRun row:", err);
    return null;
  }
}

export async function finishScrapeRun(
  supabaseUrl: string,
  serviceKey: string,
  runId: string | null,
  patch: Record<string, unknown>
): Promise<void> {
  if (!runId) return;
  try {
    await fetch(`${supabaseUrl}/rest/v1/ScrapeRun?id=eq.${runId}`, {
      method: "PATCH",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...patch, finished_at: new Date().toISOString() }),
    });
  } catch (err) {
    console.error("[Scrape] Failed to finalize ScrapeRun row:", err);
  }
}

/** Upsert rows into a table by its unique column, with the service-role key. */
export async function upsertRows(
  supabaseUrl: string,
  serviceKey: string,
  table: string,
  conflictColumn: string,
  rows: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table} upsert failed (${res.status}): ${await res.text()}`);
  return res.json();
}
