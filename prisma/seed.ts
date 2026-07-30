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
import { loadEnvConfig } from "@next/env";

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

  // ── HORECA partners, offers and demo vouchers ──────────────────────────────
  // Fictional restaurants — do NOT substitute real Karachi businesses, that
  // would imply partnerships that don't exist. Areas match the demoAreas above
  // so the rewards map lines up with the counterfeit heatmap.
  // bulk_credit_pkr is held at ~40% of consumer_value_pkr; that ratio is the
  // commercial pitch, so keep it consistent when adding offers.
  const partners = [
    {
      id: "partner_horeca_001",
      name: "Karachi Spice House",
      cuisine: "Pakistani / BBQ",
      area: "Clifton",
      latitude: 24.8138,
      longitude: 67.03,
      nfl_account_ref: "NFL-HRC-1001",
      offers: [
        {
          id: "offer_horeca_001",
          title_en: "Rs 500 Dining Credit",
          title_ur: "روپے 500 کھانے کا کریڈٹ",
          description_en: "Rs 500 off your bill on any dine-in order.",
          description_ur: "کسی بھی ڈائن اِن آرڈر پر بل میں 500 روپے کی رعایت۔",
          points_cost: 400,
          consumer_value_pkr: 500,
          bulk_credit_pkr: 200,
        },
        {
          id: "offer_horeca_002",
          title_en: "Free Dessert for Two",
          title_ur: "دو افراد کے لیے مفت میٹھا",
          description_en: "Complimentary dessert platter for two guests.",
          description_ur: "دو مہمانوں کے لیے مفت میٹھے کی پلیٹ۔",
          points_cost: 150,
          consumer_value_pkr: 350,
          bulk_credit_pkr: 140,
        },
      ],
    },
    {
      id: "partner_horeca_002",
      name: "Gulshan Biryani Center",
      cuisine: "Biryani / Desi",
      area: "Gulshan-e-Iqbal",
      latitude: 24.9216,
      longitude: 67.0942,
      nfl_account_ref: "NFL-HRC-1002",
      offers: [
        {
          id: "offer_horeca_003",
          title_en: "Rs 1,000 Family Meal Credit",
          title_ur: "روپے 1,000 فیملی کھانے کا کریڈٹ",
          description_en: "Rs 1,000 off a family biryani platter.",
          description_ur: "فیملی بریانی پلیٹر پر 1,000 روپے کی رعایت۔",
          points_cost: 800,
          consumer_value_pkr: 1000,
          bulk_credit_pkr: 400,
        },
        {
          id: "offer_horeca_004",
          title_en: "Rs 500 Dining Credit",
          title_ur: "روپے 500 کھانے کا کریڈٹ",
          description_en: "Rs 500 off your bill on any dine-in order.",
          description_ur: "کسی بھی ڈائن اِن آرڈر پر بل میں 500 روپے کی رعایت۔",
          points_cost: 400,
          consumer_value_pkr: 500,
          bulk_credit_pkr: 200,
        },
      ],
    },
    {
      id: "partner_horeca_003",
      name: "Saddar Chai Khana",
      cuisine: "Cafe / Breakfast",
      area: "Saddar Karachi",
      latitude: 24.8608,
      longitude: 67.0104,
      nfl_account_ref: "NFL-HRC-1003",
      offers: [
        {
          id: "offer_horeca_005",
          title_en: "Free Dessert for Two",
          title_ur: "دو افراد کے لیے مفت میٹھا",
          description_en: "Complimentary kheer and chai for two.",
          description_ur: "دو افراد کے لیے مفت کھیر اور چائے۔",
          points_cost: 150,
          consumer_value_pkr: 350,
          bulk_credit_pkr: 140,
        },
      ],
    },
    {
      id: "partner_horeca_004",
      name: "Korangi Kebab Corner",
      cuisine: "BBQ / Fast Food",
      area: "Korangi Industrial Area",
      latitude: 24.8328,
      longitude: 67.1025,
      nfl_account_ref: "NFL-HRC-1004",
      offers: [
        {
          id: "offer_horeca_006",
          title_en: "Rs 500 Dining Credit",
          title_ur: "روپے 500 کھانے کا کریڈٹ",
          description_en: "Rs 500 off any seekh kebab platter.",
          description_ur: "کسی بھی سیخ کباب پلیٹر پر 500 روپے کی رعایت۔",
          points_cost: 400,
          consumer_value_pkr: 500,
          bulk_credit_pkr: 200,
        },
        {
          id: "offer_horeca_007",
          title_en: "Rs 1,000 Family Meal Credit",
          title_ur: "روپے 1,000 فیملی کھانے کا کریڈٹ",
          description_en: "Rs 1,000 off a family BBQ platter.",
          description_ur: "فیملی بار بی کیو پلیٹر پر 1,000 روپے کی رعایت۔",
          points_cost: 800,
          consumer_value_pkr: 1000,
          bulk_credit_pkr: 400,
        },
      ],
    },
    {
      id: "partner_horeca_005",
      name: "Liaquatabad Karahi Co.",
      cuisine: "Karahi / Desi",
      area: "Liaquatabad",
      latitude: 24.9148,
      longitude: 67.0421,
      nfl_account_ref: "NFL-HRC-1005",
      offers: [
        {
          id: "offer_horeca_008",
          title_en: "Free Dessert for Two",
          title_ur: "دو افراد کے لیے مفت میٹھا",
          description_en: "Complimentary halwa for two guests.",
          description_ur: "دو مہمانوں کے لیے مفت حلوہ۔",
          points_cost: 150,
          consumer_value_pkr: 350,
          bulk_credit_pkr: 140,
        },
      ],
    },
  ];

  for (const { offers, ...partner } of partners) {
    await prisma.partner.upsert({
      where: { id: partner.id },
      update: {},
      create: partner,
    });
    for (const offer of offers) {
      await prisma.rewardOffer.upsert({
        where: { id: offer.id },
        update: {},
        create: { ...offer, partner_id: partner.id },
      });
    }
    console.log(`  🍽️  Partner: ${partner.name} (${offers.length} offer(s))`);
  }

  // Pre-redeemed vouchers so the dashboard HORECA tile shows real numbers on
  // first load rather than zeros. Attached to the oldest existing customer —
  // skipped if nobody has signed up yet.
  const demoUser = await prisma.user.findFirst({ orderBy: { created_at: "asc" } });
  if (!demoUser) {
    console.log("\n⏭️  No User rows yet — skipping demo voucher seed. Sign up, then re-run.");
  } else {
    const day = 24 * 60 * 60 * 1000;
    const demoVouchers = [
      { id: "voucher_seed_001", offer_id: "offer_horeca_001", code: "K7M4XR29", redeemedDaysAgo: 7 },
      { id: "voucher_seed_002", offer_id: "offer_horeca_003", code: "B8TQ5W3Z", redeemedDaysAgo: 5 },
      { id: "voucher_seed_003", offer_id: "offer_horeca_002", code: "P2HJ6N4V", redeemedDaysAgo: 4 },
      { id: "voucher_seed_004", offer_id: "offer_horeca_006", code: "D9SF3K7Y", redeemedDaysAgo: 2 },
      { id: "voucher_seed_005", offer_id: "offer_horeca_004", code: "M5RC8T2X", redeemedDaysAgo: 1 },
      { id: "voucher_seed_006", offer_id: "offer_horeca_005", code: "W4GB7Y6Q", redeemedDaysAgo: null },
    ];

    for (const v of demoVouchers) {
      await prisma.voucher.upsert({
        where: { id: v.id },
        update: {},
        create: {
          id: v.id,
          user_id: demoUser.id,
          offer_id: v.offer_id,
          code: v.code,
          status: v.redeemedDaysAgo === null ? "issued" : "redeemed",
          issued_at: new Date(Date.now() - ((v.redeemedDaysAgo ?? 0) + 2) * day),
          expires_at: new Date(Date.now() + 28 * day),
          redeemed_at: v.redeemedDaysAgo === null ? null : new Date(Date.now() - v.redeemedDaysAgo * day),
        },
      });
    }

    // Derive each partner's issued credit from the redeemed vouchers rather
    // than hardcoding a total that could drift away from them.
    const redeemed = await prisma.voucher.findMany({
      where: { status: "redeemed" },
      include: { offer: true },
    });
    const creditByPartner = new Map<string, number>();
    for (const v of redeemed) {
      creditByPartner.set(
        v.offer.partner_id,
        (creditByPartner.get(v.offer.partner_id) ?? 0) + v.offer.bulk_credit_pkr
      );
    }
    for (const [partnerId, total] of creditByPartner) {
      await prisma.partner.update({
        where: { id: partnerId },
        data: { bulk_credit_issued_pkr: total },
      });
    }

    console.log(`\n🎟️  Demo vouchers seeded for ${demoUser.email} (${redeemed.length} redeemed)`);
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
