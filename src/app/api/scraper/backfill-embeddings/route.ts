/**
 * POST /api/scraper/backfill-embeddings
 *
 * Standalone endpoint to generate embeddings for any existing `Product` rows
 * that don't have one yet — e.g. manually-created products, or rows scraped
 * before the embedding pipeline existed. Not on the scan-time hot path.
 *
 * Auth: same `Authorization: Bearer ${CRON_SECRET}` gate as the scraper route
 * (see README "National Foods Scraper & Vector Search" for manual trigger
 * instructions).
 *
 * Rows without a reference_image_url are skipped (and reported) — there's
 * nothing to embed. Sequential with a small delay to stay within the
 * Hugging Face free-tier rate limit.
 */

import { NextRequest, NextResponse } from "next/server";
import { getImageEmbedding } from "@/lib/embeddings";
import { setProductEmbedding } from "@/lib/vectorSearch";

export const runtime = "nodejs";
export const maxDuration = 300;

const REQUEST_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(req: NextRequest) {
  return handleBackfill(req);
}

export async function POST(req: NextRequest) {
  return handleBackfill(req);
}

async function handleBackfill(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: "Supabase service-role configuration missing" }, { status: 500 });
  }

  // Optional ?category=medicine|fmcg limits the backfill to one catalog, e.g.
  // embedding newly scraped medicines without touching food rows.
  const category = req.nextUrl.searchParams.get("category");
  const categoryFilter = category ? `&category=eq.${encodeURIComponent(category)}` : "";

  let products: Array<{ id: string; reference_image_url: string | null; product_name: string }>;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/Product?embedding=is.null${categoryFilter}&select=id,reference_image_url,product_name`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    if (!res.ok) {
      return NextResponse.json({ error: `Failed to fetch products missing embeddings (${res.status})` }, { status: 500 });
    }
    products = await res.json();
  } catch (err) {
    console.error("[Backfill] Failed to fetch products missing embeddings:", err);
    return NextResponse.json({ error: "Failed to fetch products missing embeddings" }, { status: 500 });
  }

  let updated = 0;
  let skippedNoImage = 0;
  let failed = 0;
  const errors: Array<{ product_id: string; error: string }> = [];

  for (const product of products) {
    if (!product.reference_image_url) {
      skippedNoImage++;
      continue;
    }

    try {
      const embedding = await getImageEmbedding(product.reference_image_url);
      if (!embedding) {
        failed++;
        errors.push({ product_id: product.id, error: "Embedding generation returned null" });
        continue;
      }

      const ok = await setProductEmbedding(product.id, embedding);
      if (ok) {
        updated++;
      } else {
        failed++;
        errors.push({ product_id: product.id, error: "set_product_embedding RPC failed" });
      }
    } catch (err) {
      failed++;
      errors.push({ product_id: product.id, error: String(err) });
      console.error(`[Backfill] Failed to backfill embedding for product ${product.id}:`, err);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  return NextResponse.json({
    processed: products.length,
    updated,
    skipped_no_image: skippedNoImage,
    failed,
    errors,
  });
}
