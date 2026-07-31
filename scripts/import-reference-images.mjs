/**
 * scripts/import-reference-images.mjs
 *
 * Bulk-loads genuine product photos into the reference catalogue, so scans can
 * be matched against them.
 *
 * This exists because the nfoods.com scraper cannot populate the catalogue:
 * every source page returns 403 to the app's HTTP client (bot mitigation —
 * curl and browsers get 200, Node's fetch does not). Supplying the brand's
 * photography directly is the reliable route, and the correct one for a
 * brand-protection product.
 *
 * Usage:
 *   node scripts/import-reference-images.mjs ./reference-images
 *   node scripts/import-reference-images.mjs ./reference-images --brand "National Foods"
 *   node scripts/import-reference-images.mjs ./reference-images --dry-run
 *
 * Filenames become product names, so name them readably:
 *   tawa-chicken-recipe-mix.jpg  ->  "Tawa Chicken Recipe Mix"
 *   biryani_masala.png           ->  "Biryani Masala"
 *
 * An optional SKU may be prefixed with a double underscore:
 *   8901030100019__tawa-chicken.jpg -> sku 8901030100019, name "Tawa Chicken"
 * Without one, a stable synthetic SKU is derived from the filename so re-runs
 * update the same row instead of creating duplicates.
 *
 * Afterwards, generate the embeddings:
 *   curl -X POST http://localhost:3000/api/scraper/backfill-embeddings \
 *        -H "Authorization: Bearer $CRON_SECRET"
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "scans";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const brandIdx = args.indexOf("--brand");
const BRAND = brandIdx !== -1 ? args[brandIdx + 1] : "National Foods";

if (!dir) {
  console.error("Usage: node scripts/import-reference-images.mjs <folder> [--brand \"National Foods\"] [--dry-run]");
  process.exit(1);
}
if (!SUPABASE_URL || !ANON_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing from .env.local");
  process.exit(1);
}
if (!SERVICE_KEY && !dryRun) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required to upload to Storage.");
  process.exit(1);
}

/** "8901030100019__tawa-chicken.jpg" -> { sku, name } */
function parseFilename(file) {
  const base = path.basename(file, path.extname(file));
  const [maybeSku, rest] = base.includes("__") ? base.split("__") : [null, base];
  const name = rest
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  // Deterministic so re-running updates rather than duplicates.
  const sku = maybeSku || `REF-${crypto.createHash("sha1").update(base).digest("hex").slice(0, 12).toUpperCase()}`;
  return { sku, name };
}

async function uploadToStorage(localPath, sku) {
  const ext = path.extname(localPath).toLowerCase();
  const objectPath = `reference/${sku}${ext}`;
  const body = await fs.readFile(localPath);

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "x-upsert": "true",
    },
    body,
  });
  if (!res.ok) throw new Error(`storage upload ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

async function upsertProduct({ sku, name, imageUrl }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/Product?on_conflict=sku`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${SERVICE_KEY ?? ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify({
      sku,
      brand_name: BRAND,
      product_name: name,
      // The scraped site publishes no batch-code format; matching is by image.
      reference_batch_pattern: ".*",
      reference_image_url: imageUrl,
      source: "reference_upload",
      last_scraped_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`product upsert ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json())[0];
}

const entries = (await fs.readdir(dir)).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()));
if (entries.length === 0) {
  console.error(`No images (${[...IMAGE_EXT].join(", ")}) found in ${dir}`);
  process.exit(1);
}

console.log(`${dryRun ? "[dry run] " : ""}Importing ${entries.length} image(s) as brand "${BRAND}"\n`);

let ok = 0;
const failures = [];
for (const file of entries) {
  const { sku, name } = parseFilename(file);
  try {
    if (dryRun) {
      console.log(`  would import  ${file}  ->  sku=${sku}  name="${name}"`);
      ok++;
      continue;
    }
    const imageUrl = await uploadToStorage(path.join(dir, file), sku);
    await upsertProduct({ sku, name, imageUrl });
    console.log(`  ✓ ${name}  (sku ${sku})`);
    ok++;
  } catch (err) {
    console.error(`  ✗ ${file}: ${err.message}`);
    failures.push(file);
  }
}

console.log(`\n${ok}/${entries.length} imported${failures.length ? `, ${failures.length} failed` : ""}`);
if (!dryRun && ok > 0) {
  console.log(
    `\nNext, generate embeddings (nothing will match until you do):\n` +
      `  curl -X POST http://localhost:3000/api/scraper/backfill-embeddings \\\n` +
      `       -H "Authorization: Bearer $CRON_SECRET"`
  );
}
