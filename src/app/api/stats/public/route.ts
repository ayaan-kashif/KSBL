/**
 * GET /api/stats/public
 *
 * Aggregate scan counters for the public landing page. Deliberately
 * unauthenticated — but for that reason it returns ONLY whole-table counts.
 * No ids, no coordinates, no per-scan rows, nothing that could identify a
 * scanner or a shop.
 *
 * Counts come back via PostgREST's `count=exact` + `Range: 0-0`, which reports
 * the total in the Content-Range header while transferring a single row. The
 * naive alternative (select every id and take .length) would pull the whole
 * Scan table over the wire on every landing-page view.
 */

import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/supabaseEnv";

// The landing page is static marketing copy around live numbers; a minute of
// staleness is irrelevant there and keeps this off the DB on every view.
export const revalidate = 60;

interface PublicStats {
  total_scans: number;
  suspicious_count: number;
  /** Share of scans that reached a confident verdict (genuine or suspicious). */
  resolved_rate: number;
}

async function countRows(
  supabaseUrl: string,
  anonKey: string,
  filter: string
): Promise<number> {
  const res = await fetch(`${supabaseUrl}/rest/v1/Scan?select=id${filter}`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      Prefer: "count=exact",
      Range: "0-0",
    },
    // Next caches this per the route's revalidate window.
    next: { revalidate },
  });

  if (!res.ok) throw new Error(`Supabase count failed: ${res.status}`);

  // Content-Range looks like "0-0/1234"; the total is after the slash. An
  // empty table answers "*/0", so parseInt on a non-numeric head yields NaN.
  const total = Number.parseInt(res.headers.get("content-range")?.split("/")[1] ?? "", 10);
  return Number.isFinite(total) ? total : 0;
}

export async function GET() {
  const { supabaseUrl, anonKey } = getSupabaseEnv();

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json(
      { error: "Supabase configuration is missing on server" },
      { status: 500 }
    );
  }

  try {
    const [total, suspicious, unverified] = await Promise.all([
      countRows(supabaseUrl, anonKey, ""),
      countRows(supabaseUrl, anonKey, "&verdict=eq.suspicious"),
      countRows(supabaseUrl, anonKey, "&verdict=eq.unverified"),
    ]);

    const stats: PublicStats = {
      total_scans: total,
      suspicious_count: suspicious,
      // NOT model accuracy: nothing in the schema records whether a verdict was
      // later confirmed correct, so there is no ground truth to measure against.
      // This is the share of scans the pipeline could actually resolve.
      resolved_rate: total > 0 ? (total - unverified) / total : 0,
    };

    return NextResponse.json(stats, { status: 200 });
  } catch (err) {
    console.error("[GET /api/stats/public] Failed:", err);
    return NextResponse.json({ error: "Failed to load stats" }, { status: 500 });
  }
}
