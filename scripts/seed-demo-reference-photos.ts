/**
 * scripts/seed-demo-reference-photos.ts
 *
 * Attaches manually-taken reference photos to the National Foods demo products
 * that prisma/seed.ts already creates, so the app has something to compare a
 * scan against on stage.
 *
 * Why this exists: the nfoods.com scraper cannot populate the catalogue. Its
 * configured URLs no longer match the live site, and the product images there
 * are lazy-loaded by JavaScript, so a fetch()+Cheerio scraper would read empty
 * src attributes even with the URLs corrected. Fixing that is out of scope —
 * this is the manual path around it.
 *
 * Deliberately a one-time local script: not a cron job, not an API route. It
 * updates existing rows only and never creates products, so it cannot drift
 * from the seed data it depends on.
 *
 * Run:  npm run seed:demo-photos
 * (Place the photos in scripts/demo-photos/ first — see the README there.)
 */

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
// Named import, unlike prisma/seed.ts's `import nextEnv from "@next/env"`:
// @next/env is CommonJS with no default export, so under ts-node's CJS interop
// the default binding is undefined and destructuring it throws.
import { loadEnvConfig } from "@next/env";

import { uploadImage } from "../src/lib/blob";
import { getImageEmbeddingFromBytes } from "../src/lib/embeddings";
import { setProductEmbedding } from "../src/lib/vectorSearch";

// Must run before any helper reads process.env. The imports above only read env
// inside their functions, so this ordering is safe despite import hoisting.
loadEnvConfig(process.cwd());

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const pool = new Pool({
  connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

interface ReferenceEntry {
  sku: string;
  imagePath: string;
  /**
   * Supply these only for products prisma/seed.ts does NOT create. With a name
   * present the row is created if missing; without one the SKU must already
   * exist and a miss is an error, so a typo can't silently mint a half-populated
   * product.
   */
  productName?: string;
  batchPattern?: string;
}

/**
 * Anything scanned on stage must be in here.
 *
 * Path A treats "not in the National Foods catalogue" as counterfeit — that is
 * the whole premise of the RAG path — so a GENUINE National product that is
 * missing from this list will be reported as a fake. The catalogue is assumed
 * complete for this brand; with only a handful of rows it very much isn't.
 */
const REFERENCE_PHOTOS: ReferenceEntry[] = [
  // Created by prisma/seed.ts — photo only.
  { sku: "8901030100019", imagePath: "scripts/demo-photos/national-ketchup.jpg" },
  { sku: "8901030200013", imagePath: "scripts/demo-photos/national-mayo.jpg" },
  // Not in prisma/seed.ts, so this one is created here.
  {
    sku: "8901030300010",
    imagePath: "scripts/demo-photos/national-tawa-chicken.jpg",
    productName: "National Tawa Chicken Recipe Mix",
    batchPattern: "^NT-\\d{3}-[A-Z]{3}$",
  },
];

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

interface Result {
  sku: string;
  uploaded: boolean;
  embedded: boolean;
  updated: boolean;
  note?: string;
}

async function seedOne(entry: ReferenceEntry): Promise<Result> {
  const { sku, imagePath, productName, batchPattern } = entry;
  const result: Result = { sku, uploaded: false, embedded: false, updated: false };

  let product = await prisma.product.findUnique({ where: { sku } });

  if (!product && !productName) {
    result.note = `No Product row with sku ${sku}, and no productName given to create one. Run \`npm run db:seed\`, or add a productName to this entry.`;
    console.error(`❌ ${sku}: ${result.note}`);
    return result;
  }

  if (!product && productName) {
    product = await prisma.product.create({
      data: {
        sku,
        brand_name: "National Foods",
        product_name: productName,
        // The brand publishes no batch-code format; identification here is by
        // image, so this is only a placeholder for the NOT NULL column.
        reference_batch_pattern: batchPattern ?? ".*",
        source: "manual",
      },
    });
    console.log(`\n🆕 created  ${productName}  (sku ${sku})`);
  }

  if (!product) {
    result.note = `Could not resolve a Product row for sku ${sku}`;
    console.error(`❌ ${sku}: ${result.note}`);
    return result;
  }

  const absolutePath = path.resolve(process.cwd(), imagePath);
  if (!fs.existsSync(absolutePath)) {
    result.note = `Photo not found at ${imagePath} — see scripts/demo-photos/README.md`;
    console.error(`❌ ${sku} (${product.product_name}): ${result.note}`);
    return result;
  }

  console.log(`\n📦 ${product.product_name}  (sku ${sku})`);

  // ── Upload ────────────────────────────────────────────────────────────────
  // Fixed object name keyed on the SKU, so re-running overwrites the same
  // object instead of littering storage with copies.
  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? "image/jpeg";
  const filename = `reference/demo-${sku}${ext}`;

  const bytes = fs.readFileSync(absolutePath);

  let uploadedUrl: string;
  try {
    const blob = new Blob([bytes], { type: contentType });
    uploadedUrl = await uploadImage(filename, blob);
    result.uploaded = true;
    console.log(`   ✅ uploaded  ${uploadedUrl}`);
  } catch (err) {
    result.note = `Upload failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`   ❌ upload    ${result.note}`);
    return result;
  }

  // ── Embedding ─────────────────────────────────────────────────────────────
  // A failure here is survivable: the reference URL is still worth storing, so
  // the pixel/structural comparison can use it even without a vector.
  // Embed the bytes we just uploaded, NOT the public URL. Re-fetching the URL
  // can return the CDN's stale copy of a replaced object, which silently
  // embeds the previous photo while still reporting success.
  let embedding: number[] | null = null;
  try {
    embedding = await getImageEmbeddingFromBytes(bytes);
  } catch (err) {
    console.warn(`   ⚠️  embedding call threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!embedding) {
    console.warn(
      "   ⚠️  embedding  returned null — vector search will not match this product. " +
        "Reference URL is still being saved."
    );
  }

  // ── Update the row ────────────────────────────────────────────────────────
  try {
    await prisma.product.update({
      where: { sku },
      data: {
        reference_image_url: uploadedUrl,
        // Reused rather than adding a column: downstream freshness checks
        // already read this field.
        last_scraped_at: new Date(),
      },
    });
    result.updated = true;
    console.log("   ✅ db        reference_image_url + last_scraped_at set");
  } catch (err) {
    result.note = `DB update failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`   ❌ db        ${result.note}`);
    return result;
  }

  if (embedding) {
    // Same helper the scraper route uses — Prisma Client cannot write the
    // Unsupported("vector") column, so this goes through the PostgREST RPC.
    const ok = await setProductEmbedding(product.id, embedding);
    result.embedded = ok;
    console.log(
      ok
        ? `   ✅ embedding  ${embedding.length}-dim vector stored`
        : "   ⚠️  embedding  setProductEmbedding returned false — vector not stored"
    );
  }

  return result;
}

async function main() {
  console.log("🌱 Seeding National Foods demo reference photos...");

  const results: Result[] = [];
  for (const entry of REFERENCE_PHOTOS) {
    results.push(await seedOne(entry));
  }

  console.log("\n─────────────── summary ───────────────");
  for (const r of results) {
    const marks = [
      `upload ${r.uploaded ? "✅" : "❌"}`,
      `db ${r.updated ? "✅" : "❌"}`,
      `embedding ${r.embedded ? "✅" : "⚠️"}`,
    ].join("  ");
    console.log(`${r.sku}  ${marks}${r.note ? `\n    ${r.note}` : ""}`);
  }

  const fullySeeded = results.filter((r) => r.updated && r.embedded).length;
  console.log(
    `\n${fullySeeded}/${REFERENCE_PHOTOS.length} product(s) ready for an image-based verdict.`
  );
  if (fullySeeded < REFERENCE_PHOTOS.length) {
    console.log(
      "Products without an embedding will not be found by vector search. " +
        "Check the warnings above before demoing."
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
