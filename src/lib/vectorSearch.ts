/**
 * lib/vectorSearch.ts
 *
 * RAG-style product identification from a scan photo alone, for brands
 * (e.g. National Foods) that have no barcode/SKU database.
 *
 * Talks to Postgres exclusively through the Supabase PostgREST RPC endpoint —
 * same convention as findProduct() in verifyProduct.ts — rather than a direct
 * Prisma/pg connection, since pgvector's `<=>` cosine-distance ORDER BY can't
 * be expressed through plain PostgREST query params. The RPC function itself
 * (match_products) lives in prisma/sql/pgvector_setup.sql.
 *
 * Required env vars:
 *   NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY — shared with the
 *     rest of the app's REST-based DB access
 *   VECTOR_MATCH_THRESHOLD — (optional) cosine similarity cutoff, default 0.85
 *
 * Fallback: returns null on any failure (missing embedding, missing config,
 * no match above threshold, RPC error). Never throws.
 */

import { getImageEmbedding } from "./embeddings";

// This is the FLOOR handed to the RPC, not a verdict cutoff. Path A in
// services/verificationPaths.ts bands the returned similarity, so the RPC has
// to return middle-band candidates rather than discarding them — hence the
// floor tracks VECTOR_MATCH_LOW (0.82) rather than the old 0.85.
const DEFAULT_MATCH_THRESHOLD = 0.82;
const RPC_TIMEOUT_MS = 6000;

export interface VectorMatch {
  product: {
    id: string;
    sku: string;
    brand_name: string;
    product_name: string;
    reference_batch_pattern: string;
    reference_image_url: string | null;
    avg_unit_price_pkr: number;
  };
  similarity: number;
}

/**
 * Identify a product from a scanned image via CLIP embedding + cosine
 * similarity search. Returns null if no embedding could be generated, no
 * match clears the threshold, or the RPC call fails.
 */
export async function findProductByImage(
  imageUrl: string,
  brandFilter?: string | null
): Promise<VectorMatch | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return null;

  const embedding = await getImageEmbedding(imageUrl);
  if (!embedding) return null;

  // VECTOR_MATCH_LOW is the band boundary Path A adjudicates from; honour it
  // as the RPC floor so the two can't drift apart and silently drop the
  // bottom of the middle band.
  const threshold =
    Number(process.env.VECTOR_MATCH_THRESHOLD) ||
    Number(process.env.VECTOR_MATCH_LOW) ||
    DEFAULT_MATCH_THRESHOLD;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/match_products`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query_embedding: embedding,
        match_threshold: threshold,
        brand_filter: brandFilter ?? null,
        match_count: 1,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`[VectorSearch] match_products RPC returned ${res.status}`);
      return null;
    }

    const rows = (await res.json()) as Array<VectorMatch["product"] & { similarity: number }>;
    if (!rows || rows.length === 0) return null;

    const { similarity, ...product } = rows[0];
    return { product, similarity };
  } catch (err) {
    console.error("[VectorSearch] findProductByImage failed:", err);
    return null;
  }
}

/**
 * Write/overwrite a product's embedding via the set_product_embedding RPC
 * (prisma/sql/pgvector_setup.sql) — used by the scraper and the embedding
 * backfill route. Prisma Client can't write Unsupported("vector") columns,
 * so this goes through PostgREST like everything else. Never throws.
 */
export async function setProductEmbedding(productId: string, embedding: number[]): Promise<boolean> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return false;

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/set_product_embedding`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_id: productId, p_embedding: embedding }),
    });
    if (!res.ok) {
      console.warn(`[VectorSearch] set_product_embedding RPC returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[VectorSearch] setProductEmbedding failed:", err);
    return false;
  }
}
