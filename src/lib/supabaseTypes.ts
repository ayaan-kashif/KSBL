/**
 * src/lib/supabaseTypes.ts
 *
 * Row shapes for the PostgREST responses the API routes consume.
 *
 * These are hand-written rather than generated because the routes select
 * explicit column lists (`?select=verdict,confidence,...`), so what comes back
 * is a projection of a table, never the whole model. Every field is therefore
 * optional-by-nullability: a column that was not selected is simply absent, and
 * `?? null` fallbacks throughout the routes already assume that.
 *
 * The point of these types is to replace `any` in `.map`/`.filter` callbacks so
 * a typo in a column name fails at build time instead of silently producing
 * `undefined` in a report.
 */

export type Verdict = 'genuine' | 'suspicious' | 'unverified' | 'counterfeit';
export type ScannedByRole = 'shopkeeper' | 'consumer';
export type ProductStatus = 'active' | 'flagged' | 'recalled';

/** An embedded `product:Product(...)` join, as PostgREST returns it. */
export interface ScanProductJoin {
  product_name?: string | null;
  brand_name?: string | null;
  avg_unit_price_pkr?: number | null;
}

/**
 * A row from the Scan table. Every field is optional because each route selects
 * only the columns it needs.
 */
export interface ScanRow {
  id?: string;
  verdict?: Verdict | null;
  confidence?: number | null;
  product_id?: string | null;
  product_name?: string | null;
  brand_name?: string | null;
  category?: string | null;
  barcode?: string | null;
  area_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  scanned_by_role?: ScannedByRole | null;
  extracted_batch?: string | null;
  extracted_mfg_date?: string | null;
  extracted_mrp?: string | null;
  cv_anomaly_score?: number | null;
  ocr_raw_json?: unknown;
  image_url?: string | null;
  created_at?: string | null;
  /** Present only when the query joins Product. */
  product?: ScanProductJoin | null;
}

/** A row from the Product table, optionally with its joined scans. */
export interface ProductRow {
  id?: string;
  sku?: string | null;
  product_name?: string | null;
  brand_name?: string | null;
  status?: ProductStatus | null;
  avg_unit_price_pkr?: number | null;
  reference_batch_pattern?: string | null;
  reference_image_url?: string | null;
  /** Present only when the query joins Scan. */
  scans?: ScanRow[] | null;
}

/** A row from the Brand table. */
export interface BrandRow {
  id?: string;
  name?: string | null;
  contact_email?: string | null;
}

/* ── Formatting helpers ──────────────────────────────────────────────────────
   Report and export routes read these columns straight into user-facing text,
   where a null used to become "NaN%" or "Invalid Date" in a downloaded file.
   Routing every read through these keeps a missing column visible as an honest
   placeholder instead of a broken-looking number. */

/** `0.913` → `"91%"`. Null/undefined → `"n/a"`, never `"NaN%"`. */
export function formatConfidencePct(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value * 100)}%`
    : 'n/a';
}

/** ISO timestamp → locale date. Null or unparseable → `"unknown"`. */
export function formatScanDate(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleDateString();
}

/** First 8 characters of an id, for compact report columns. */
export function shortId(value: string | null | undefined): string {
  return value ? value.substring(0, 8) : 'unknown';
}
