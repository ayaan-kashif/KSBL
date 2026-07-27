/**
 * prisma/seed.ts
 *
 * Seeds demo data for the ShelfWatch hackathon demo.
 * Creates 2 brands and 6 FMCG products commonly counterfeited in Pakistan.
 *
 * Run: npx prisma db seed
 *      (or: npx ts-node prisma/seed.ts)
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const pool = new Pool({
  connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🌱 Seeding ShelfWatch demo data...");

  // ── Brands ─────────────────────────────────────────────────────────────────
  const unilever = await prisma.brand.upsert({
    where: { contact_email: "anti-counterfeit@unilever.pk" },
    update: {},
    create: {
      name: "Unilever Pakistan",
      contact_email: "anti-counterfeit@unilever.pk",
      subscription_tier: "enterprise",
    },
  });

  const national = await prisma.brand.upsert({
    where: { contact_email: "protection@national-foods.pk" },
    update: {},
    create: {
      name: "National Foods",
      contact_email: "protection@national-foods.pk",
      subscription_tier: "professional",
    },
  });

  console.log(`✅ Brands created: ${unilever.name}, ${national.name}`);

  // ── Products ───────────────────────────────────────────────────────────────
  const products = [
    {
      sku: "8901030873874",
      brand_name: "Unilever Pakistan",
      product_name: "Surf Excel Matic Front Load 1kg",
      reference_batch_pattern: "^SE[FM]-\\d{3}-[A-Z]{2,3}$",
      avg_unit_price_pkr: 485,
    },
    {
      sku: "8901030840363",
      brand_name: "Unilever Pakistan",
      product_name: "Lifebuoy Total 10 Soap 120g",
      reference_batch_pattern: "^LB-\\d{4}-[A-Z]{2,4}$",
      avg_unit_price_pkr: 120,
    },
    {
      sku: "8901030895616",
      brand_name: "Unilever Pakistan",
      product_name: "Sunsilk Shampoo Black Shine 185ml",
      reference_batch_pattern: "^SS[BS]-\\d{3}-KHI|LHR|ISB$",
      avg_unit_price_pkr: 265,
    },
    {
      sku: "8901030821065",
      brand_name: "Unilever Pakistan",
      product_name: "Dove Beauty Bar 75g",
      reference_batch_pattern: "^DV-\\d{3}-[A-Z]{2,3}$",
      avg_unit_price_pkr: 180,
    },
    {
      sku: "8901030100019",
      brand_name: "National Foods",
      product_name: "National Ketchup 400g",
      reference_batch_pattern: "^NK-\\d{3}-[A-Z]{3}$",
      avg_unit_price_pkr: 195,
    },
    {
      sku: "8901030200013",
      brand_name: "National Foods",
      product_name: "National Mayonnaise 500ml",
      reference_batch_pattern: "^NM-\\d{4}-[A-Z]{2,3}$",
      avg_unit_price_pkr: 320,
    },
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { sku: p.sku },
      update: {},
      create: p,
    });
    console.log(`  📦 Product: ${p.product_name}`);
  }

  // ── Demo scan + report data for the dashboard ──────────────────────────────
  const surfExcel = await prisma.product.findUnique({
    where: { sku: "8901030873874" },
  });

  if (surfExcel) {
    const demoAreas = [
      { area: "Korangi Industrial Area", lat: 24.8328, lng: 67.1025, verdict: "suspicious" as const },
      { area: "Liaquatabad", lat: 24.9148, lng: 67.0421, verdict: "suspicious" as const },
      { area: "Saddar Karachi", lat: 24.8608, lng: 67.0104, verdict: "genuine" as const },
      { area: "Gulshan-e-Iqbal", lat: 24.9216, lng: 67.0942, verdict: "genuine" as const },
      { area: "SITE Area", lat: 24.9087, lng: 66.9989, verdict: "suspicious" as const },
      { area: "Orangi Town", lat: 24.9495, lng: 67.0142, verdict: "suspicious" as const },
      { area: "DHA Karachi", lat: 24.8103, lng: 67.0652, verdict: "genuine" as const },
    ];

    for (const demo of demoAreas) {
      const scan = await prisma.scan.create({
        data: {
          product_id: surfExcel.id,
          scanned_by_role: "shopkeeper",
          image_url: "https://placeholder.shelfwatch.pk/demo-scan.jpg",
          extracted_batch:
            demo.verdict === "suspicious" ? "FAKE-001-XX" : "SEFM-123-KHI",
          cv_anomaly_score: demo.verdict === "suspicious" ? 0.82 : 0.18,
          verdict: demo.verdict,
          confidence: demo.verdict === "suspicious" ? 0.82 : 0.91,
          latitude: demo.lat + (Math.random() - 0.5) * 0.01,
          longitude: demo.lng + (Math.random() - 0.5) * 0.01,
          area_name: demo.area,
        },
      });

      if (demo.verdict === "suspicious") {
        await prisma.report.create({
          data: {
            scan_id: scan.id,
            brand_id: unilever.id,
            status: "pending",
            notes: "Demo suspicious scan — packaging anomaly detected",
          },
        });
      }
    }

    console.log(`\n🗺️  Demo scans + reports created for ${demoAreas.length} Karachi areas`);
  }

  console.log("\n✅ Seed complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
