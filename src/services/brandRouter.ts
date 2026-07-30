/**
 * services/brandRouter.ts
 *
 * Decides WHICH verification path a scan belongs on, before any verification
 * work runs.
 *
 * The two paths need different evidence, and a miss means something different
 * on each:
 *
 *  - National Foods has no public barcode database — that's the reason the
 *    scraper and the pgvector catalog exist. Our catalog is meant to be
 *    complete for this brand, so a National Foods product that ISN'T in it is
 *    a genuine counterfeit signal.
 *  - Everything else goes to UPCItemDB / Open Food Facts / Barcode Lookup,
 *    which carry international SKUs but not National Foods ones. A miss there
 *    means "no reference available", not "fake" — those databases have large
 *    coverage gaps.
 *
 * Resolution order is cheapest-and-most-reliable first, stopping at the first
 * hit. If everything fails we return isNationalFoods:false, which routes to
 * the external path — the safer failure mode, since it can only ever produce
 * "unverified", never a false counterfeit accusation.
 *
 * Env:
 *   NATIONAL_BRAND_ALIASES — comma-separated, case-insensitive.
 *                            Default "national,national foods,nfl,نیشنل".
 */

import { detectBrandFromImage } from "./geminiVision";

export type BrandSource = "local_catalog" | "sku_prefix" | "vision" | "unknown";

export interface BrandContext {
  isNationalFoods: boolean;
  detectedBrand: string | null;
  source: BrandSource;
  confidence: number; // 0–1
}

const DEFAULT_ALIASES = "national,national foods,nfl,نیشنل";
const PREFIX_LENGTH = 7; // GS1 company prefix
const PREFIX_FETCH_TIMEOUT_MS = 5000;

function nationalAliases(): string[] {
  return (process.env.NATIONAL_BRAND_ALIASES ?? DEFAULT_ALIASES)
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Does this brand string name National Foods? Substring rather than equality
 * so catalog values like "National Foods Pakistan" and vision output like
 * "NATIONAL FOODS LTD" both resolve.
 */
export function isNationalBrand(brand: string | null | undefined): boolean {
  if (!brand) return false;
  const needle = brand.trim().toLowerCase();
  if (!needle) return false;
  return nationalAliases().some((alias) => needle.includes(alias));
}

// ─── SKU prefix set, derived at runtime from our own catalog ────────────────
// Deliberately NOT a hardcoded list: the scraper's catalog is the source of
// truth for which GS1 prefixes National Foods actually ships under, and that
// changes as the catalog grows. Cached in module scope for the process
// lifetime — this is a serverless-warm cache, not a correctness guarantee.

let prefixCache: Set<string> | null = null;
let prefixCachePromise: Promise<Set<string>> | null = null;

async function fetchProductSkus(): Promise<Array<{ sku: string; brand_name: string }>> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return [];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PREFIX_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/Product?select=sku,brand_name`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[BrandRouter] SKU fetch returned ${res.status}`);
      return [];
    }
    return (await res.json()) as Array<{ sku: string; brand_name: string }>;
  } catch (err) {
    console.error("[BrandRouter] SKU fetch failed:", err);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Leading-7-digit prefixes that belong to National Foods AND to nobody else
 * in the catalog.
 *
 * The exclusivity check matters: a prefix shared with another brand is not
 * evidence of anything. In the current demo catalog every Unilever SKU starts
 * with the same 8901030 as the National Foods rows, so without this guard the
 * prefix step would route every Unilever scan down the National RAG path —
 * exactly the false positive this router exists to prevent. With real scraped
 * data no prefix is shared and nothing gets excluded.
 */
async function nationalSkuPrefixes(): Promise<Set<string>> {
  if (prefixCache) return prefixCache;
  if (prefixCachePromise) return prefixCachePromise;

  prefixCachePromise = (async () => {
    const rows = await fetchProductSkus();
    const national = new Set<string>();
    const others = new Set<string>();

    for (const row of rows) {
      const digits = (row.sku ?? "").replace(/\D/g, "");
      if (digits.length < PREFIX_LENGTH) continue;
      const prefix = digits.slice(0, PREFIX_LENGTH);
      (isNationalBrand(row.brand_name) ? national : others).add(prefix);
    }

    for (const shared of others) national.delete(shared);

    // Don't cache an empty result from a failed/empty fetch — a later call
    // (or a populated catalog) should get a real answer.
    if (national.size > 0) prefixCache = national;
    prefixCachePromise = null;
    return national;
  })();

  return prefixCachePromise;
}

/** Test/ops hook — drop the memoised prefix set. */
export function resetBrandPrefixCache(): void {
  prefixCache = null;
  prefixCachePromise = null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ResolveBrandInput {
  /** brand_name from a Product row already matched by barcode, if any. */
  localCatalogBrand?: string | null;
  /** Scanned/detected barcode, if any. */
  barcode?: string | null;
  /** Front photo, for the vision fallback. */
  imageBase64?: string | null;
  mimeType?: string | null;
}

/**
 * Resolve the brand context for a scan. Stops at the first step that produces
 * an answer; never throws.
 */
export async function resolveBrandContext(input: ResolveBrandInput): Promise<BrandContext> {
  // 1. Local catalog — the barcode already matched one of our own rows, so the
  //    brand is recorded fact rather than inference.
  if (input.localCatalogBrand) {
    return {
      isNationalFoods: isNationalBrand(input.localCatalogBrand),
      detectedBrand: input.localCatalogBrand,
      source: "local_catalog",
      confidence: 1,
    };
  }

  // 2. SKU prefix — cheap, offline, and exact when the prefix is exclusive.
  const digits = (input.barcode ?? "").replace(/\D/g, "");
  if (digits.length >= PREFIX_LENGTH) {
    const prefixes = await nationalSkuPrefixes();
    if (prefixes.has(digits.slice(0, PREFIX_LENGTH))) {
      return {
        isNationalFoods: true,
        detectedBrand: "National Foods",
        source: "sku_prefix",
        // Not 1.0: a GS1 company prefix identifies the barcode's registrant,
        // which is strong evidence but still an inference about this packet.
        confidence: 0.9,
      };
    }
  }

  // 3. Vision — one short Gemini call reading the wordmark off the packaging.
  if (input.imageBase64) {
    const detected = await detectBrandFromImage(input.imageBase64, input.mimeType ?? "image/jpeg");
    if (detected) {
      return {
        isNationalFoods: isNationalBrand(detected.brand),
        detectedBrand: detected.brand,
        source: "vision",
        confidence: detected.confidence,
      };
    }
  }

  // 4. Nothing resolved. Default to the external path: it can only ever return
  //    "unverified" on a miss, whereas defaulting to the National path would
  //    risk calling an unidentified product counterfeit purely because it
  //    isn't in a catalog it was never supposed to be in.
  return {
    isNationalFoods: false,
    detectedBrand: null,
    source: "unknown",
    confidence: 0,
  };
}

// ─── Catalog coverage guard ─────────────────────────────────────────────────

/**
 * How many National Foods rows actually carry an embedding.
 *
 * Path A treats "not in the catalog" as a counterfeit signal, which is only a
 * valid inference if the catalog is populated. With zero embedded rows every
 * scan would land in the bottom band and the failure would be indistinguishable
 * from "the feature works and everything is fake". Callers use this to
 * downgrade that verdict to `unverified` with a diagnostic instead.
 *
 * Returns -1 if coverage can't be determined (treated as "don't downgrade",
 * since an unreachable count is not evidence the catalog is empty).
 */
export async function nationalCatalogEmbeddingCount(): Promise<number> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return -1;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PREFIX_FETCH_TIMEOUT_MS);
    // HEAD + Prefer: count=exact returns the tally in Content-Range without
    // transferring rows — and `embedding` can't be selected through PostgREST
    // anyway (Prisma maps it as an Unsupported column type).
    const res = await fetch(
      `${supabaseUrl}/rest/v1/Product?select=id&embedding=not.is.null&brand_name=ilike.*national*`,
      {
        method: "HEAD",
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          Prefer: "count=exact",
        },
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);
    if (!res.ok) return -1;

    const range = res.headers.get("content-range"); // e.g. "0-4/5" or "*/0"
    const total = range?.split("/")[1];
    const parsed = Number(total);
    return Number.isFinite(parsed) ? parsed : -1;
  } catch (err) {
    console.error("[BrandRouter] coverage check failed:", err);
    return -1;
  }
}
