/**
 * services/medicineCatalog.ts
 *
 * Identify a scanned medicine against our own catalog (Product rows with
 * category "medicine", filled by /api/scraper/pharma), cheapest and most
 * certain first:
 *   1. GTIN       — exact, when the catalog row has one (most pharma sites
 *                   publish none, so this rarely hits yet).
 *   2. Image      — CLIP vector match restricted to medicine rows.
 *   3. Printed text — brand name + strength read off the pack.
 * Not finding a product is neutral: the catalog is incomplete by nature.
 */

import { findProductByImage } from "@/lib/vectorSearch";
import { brandsMatch, strengthsOverlap } from "@/lib/pharmaText";
import type { UnifiedProduct } from "./cacheService";
import type { MedicinePrinted } from "./geminiVision";

export interface CatalogMedicine {
  id: string;
  sku: string;
  product_name: string;
  brand_name: string;
  manufacturer: string | null;
  generic_name: string | null;
  strength: string | null;
  dosage_form: string | null;
  drap_reg_no: string | null;
  reference_image_url: string | null;
  source_url: string | null;
}

export interface MedicineIdentity {
  product: CatalogMedicine | null;
  via: "gtin" | "image" | "text" | null;
  similarity: number | null;
}

const SELECT = "id,sku,product_name,brand_name,manufacturer,generic_name,strength,dosage_form,drap_reg_no,reference_image_url,source_url";
const QUERY_TIMEOUT_MS = 4000;
/** Same floor food uses for a confirmed image match (VECTOR_MATCH_HIGH default). */
const IMAGE_MATCH_FLOOR = Number(process.env.VECTOR_MATCH_HIGH) || 0.92;

const NONE: MedicineIdentity = { product: null, via: null, similarity: null };

async function query(params: string): Promise<CatalogMedicine[]> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return [];
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/Product?category=eq.medicine&select=${SELECT}&${params}`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    return res.ok ? ((await res.json()) as CatalogMedicine[]) : [];
  } catch (err) {
    console.error("[MedicineCatalog] query failed:", err);
    return [];
  }
}

async function byId(id: string): Promise<CatalogMedicine | null> {
  return (await query(`id=eq.${encodeURIComponent(id)}`))[0] ?? null;
}

/** Steps 1–2: needs no printed text, so it can run before the Gemini call and hand it a reference image. */
export async function identifyByCodeOrImage(gtin: string | null, imageUrl: string | null): Promise<MedicineIdentity> {
  if (gtin) {
    const g13 = gtin.length === 14 && gtin.startsWith("0") ? gtin.slice(1) : gtin;
    const g14 = g13.padStart(14, "0");
    const hit = (await query(`or=(gtin.eq.${g13},gtin.eq.${g14})&limit=1`))[0];
    if (hit) return { product: hit, via: "gtin", similarity: null };
  }
  if (imageUrl) {
    const match = await findProductByImage(imageUrl, null, IMAGE_MATCH_FLOOR, "medicine");
    if (match) {
      const product = await byId(match.product.id);
      if (product) return { product, via: "image", similarity: match.similarity };
    }
  }
  return NONE;
}

/** Step 3: printed brand, narrowed by strength when the pack shows one. */
export async function identifyByText(brand: string | null, strength: string | null): Promise<MedicineIdentity> {
  const word = brand?.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/)[0];
  if (!word || word.length < 3) return NONE;
  const candidates = (await query(`product_name=ilike.${encodeURIComponent(`${word}*`)}&limit=20`)).filter(
    (c) => brandsMatch(c.product_name, brand) !== false
  );
  // With a printed strength, require it; a brand alone spans many strengths.
  const pick = strength
    ? candidates.find((c) => strengthsOverlap(c.strength ?? c.product_name, strength) === true)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  return pick ? { product: pick, via: "text", similarity: null } : NONE;
}

/** The reference shape geminiVision compares against. */
export function catalogMedicineToUnified(p: CatalogMedicine | null): UnifiedProduct | null {
  if (!p) return null;
  return {
    name: [p.product_name, p.strength].filter(Boolean).join(" "),
    brand: p.product_name,
    manufacturer: p.manufacturer ?? p.brand_name,
    category: "Medicine",
    barcode: "",
    size: p.dosage_form ?? "Unknown",
    referenceImage: p.reference_image_url ?? "",
  };
}

/** What the pack itself prints, for display when there's no catalogue match. */
export function printedMedicineToUnified(p: MedicinePrinted | null): UnifiedProduct | null {
  if (!p?.brandName) return null;
  return {
    name: [p.brandName, p.strength].filter(Boolean).join(" "),
    brand: p.brandName,
    manufacturer: p.manufacturer ?? "Not visible",
    category: "Medicine",
    barcode: "",
    size: p.packSize ?? "Not visible",
    referenceImage: "",
  };
}
