-- ─────────────────────────────────────────────────────────────────────────────
-- HORECA voucher tables — Partner / RewardOffer / Voucher
--
-- Same fallback pattern as prisma/sql/manual_schema_patch.sql: schema.prisma is
-- the source of truth, but this file lets you apply the identical change by
-- pasting into the Supabase SQL Editor when the pooler isn't reachable from the
-- CLI. Everything here is idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING),
-- so running it twice, or running `prisma db push` afterwards, is safe.
--
-- Run order: manual_schema_patch.sql → pgvector_setup.sql → THIS FILE.
-- (It only depends on "User" already existing.)
--
-- THREE THINGS IN HERE ARE LOAD-BEARING — do not "simplify" them away:
--
--  1. `id text DEFAULT gen_random_uuid()::text` on all three tables. Writes go
--     through PostgREST, not Prisma Client, so Prisma's @default(cuid()) never
--     fires at the database level and every insert that omits "id" would fail
--     with a NOT NULL violation. Declared in schema.prisma too, so a later
--     `db push` won't drop it as drift.
--
--  2. The named FOREIGN KEY constraints. PostgREST derives its embedded-join
--     syntax (`select=*,offer:RewardOffer(*)`, used by /api/vouchers/mine and
--     /api/rewards) from actual FK metadata. Without a real FK the join does
--     not error — it silently returns null, which is far worse to debug.
--
--  3. The NOTIFY at the bottom. PostgREST caches the schema; new tables are
--     invisible over REST until it reloads.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Enum ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "VoucherStatus" AS ENUM ('issued', 'redeemed', 'expired');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── Partner ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Partner" (
  "id"                     text NOT NULL DEFAULT gen_random_uuid()::text,
  "name"                   text NOT NULL,
  "cuisine"                text NOT NULL,
  "area"                   text NOT NULL,
  "latitude"               double precision,
  "longitude"              double precision,
  "logo_url"               text,
  "nfl_account_ref"        text,
  "bulk_credit_issued_pkr" double precision NOT NULL DEFAULT 0,
  "active"                 boolean NOT NULL DEFAULT true,
  "created_at"             timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Partner_area_idx"   ON "Partner"("area");
CREATE INDEX IF NOT EXISTS "Partner_active_idx" ON "Partner"("active");

-- ── RewardOffer ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RewardOffer" (
  "id"                 text NOT NULL DEFAULT gen_random_uuid()::text,
  "partner_id"         text NOT NULL,
  "title_en"           text NOT NULL,
  "title_ur"           text NOT NULL,
  "description_en"     text NOT NULL,
  "description_ur"     text NOT NULL,
  "points_cost"        integer NOT NULL,
  "consumer_value_pkr" double precision NOT NULL,
  "bulk_credit_pkr"    double precision NOT NULL,
  "active"             boolean NOT NULL DEFAULT true,
  "created_at"         timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RewardOffer_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "RewardOffer"
    ADD CONSTRAINT "RewardOffer_partner_id_fkey"
    FOREIGN KEY ("partner_id") REFERENCES "Partner"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "RewardOffer_partner_id_idx" ON "RewardOffer"("partner_id");
CREATE INDEX IF NOT EXISTS "RewardOffer_active_idx"     ON "RewardOffer"("active");

-- ── Voucher ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Voucher" (
  "id"          text NOT NULL DEFAULT gen_random_uuid()::text,
  "user_id"     text NOT NULL,
  "offer_id"    text NOT NULL,
  "code"        text NOT NULL,
  "status"      "VoucherStatus" NOT NULL DEFAULT 'issued',
  "issued_at"   timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"  timestamptz(3) NOT NULL,
  "redeemed_at" timestamptz(3),
  CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Voucher_code_key" ON "Voucher"("code");

DO $$ BEGIN
  ALTER TABLE "Voucher"
    ADD CONSTRAINT "Voucher_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Voucher"
    ADD CONSTRAINT "Voucher_offer_id_fkey"
    FOREIGN KEY ("offer_id") REFERENCES "RewardOffer"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "Voucher_user_id_idx"  ON "Voucher"("user_id");
CREATE INDEX IF NOT EXISTS "Voucher_offer_id_idx" ON "Voucher"("offer_id");
CREATE INDEX IF NOT EXISTS "Voucher_status_idx"   ON "Voucher"("status");

-- ─────────────────────────────────────────────────────────────────────────────
-- Demo seed data
--
-- Mirrors prisma/seed.ts, repeated here so the demo can be brought up entirely
-- from the SQL Editor without the pooler. Fixed ids (not gen_random_uuid())
-- purely so this block is re-runnable and the two seed paths can't produce
-- duplicate partners.
--
-- Restaurant names are FICTIONAL. Do not swap in real Karachi businesses —
-- that would imply partnerships that do not exist.
--
-- Areas deliberately match the heatmap seed areas in prisma/seed.ts so the
-- rewards map and the counterfeit-scan map line up on stage.
--
-- bulk_credit_pkr is held at ~40% of consumer_value_pkr throughout. That ratio
-- IS the pitch (voucher costs NFL wholesale COGS, reads as retail value to the
-- consumer), so keep it consistent if you add offers.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "Partner" ("id", "name", "cuisine", "area", "latitude", "longitude", "nfl_account_ref") VALUES
  ('partner_horeca_001', 'Karachi Spice House',   'Pakistani / BBQ',   'Clifton',          24.8138, 67.0300, 'NFL-HRC-1001'),
  ('partner_horeca_002', 'Gulshan Biryani Center','Biryani / Desi',    'Gulshan-e-Iqbal',  24.9216, 67.0942, 'NFL-HRC-1002'),
  ('partner_horeca_003', 'Saddar Chai Khana',     'Cafe / Breakfast',  'Saddar Karachi',   24.8608, 67.0104, 'NFL-HRC-1003'),
  ('partner_horeca_004', 'Korangi Kebab Corner',  'BBQ / Fast Food',   'Korangi Industrial Area', 24.8328, 67.1025, 'NFL-HRC-1004'),
  ('partner_horeca_005', 'Liaquatabad Karahi Co.','Karahi / Desi',     'Liaquatabad',      24.9148, 67.0421, 'NFL-HRC-1005')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "RewardOffer" ("id", "partner_id", "title_en", "title_ur", "description_en", "description_ur", "points_cost", "consumer_value_pkr", "bulk_credit_pkr") VALUES
  ('offer_horeca_001', 'partner_horeca_001', 'Rs 500 Dining Credit', 'روپے 500 کھانے کا کریڈٹ',
   'Rs 500 off your bill on any dine-in order.', 'کسی بھی ڈائن اِن آرڈر پر بل میں 500 روپے کی رعایت۔', 400, 500, 200),
  ('offer_horeca_002', 'partner_horeca_001', 'Free Dessert for Two', 'دو افراد کے لیے مفت میٹھا',
   'Complimentary dessert platter for two guests.', 'دو مہمانوں کے لیے مفت میٹھے کی پلیٹ۔', 150, 350, 140),
  ('offer_horeca_003', 'partner_horeca_002', 'Rs 1,000 Family Meal Credit', 'روپے 1,000 فیملی کھانے کا کریڈٹ',
   'Rs 1,000 off a family biryani platter.', 'فیملی بریانی پلیٹر پر 1,000 روپے کی رعایت۔', 800, 1000, 400),
  ('offer_horeca_004', 'partner_horeca_002', 'Rs 500 Dining Credit', 'روپے 500 کھانے کا کریڈٹ',
   'Rs 500 off your bill on any dine-in order.', 'کسی بھی ڈائن اِن آرڈر پر بل میں 500 روپے کی رعایت۔', 400, 500, 200),
  ('offer_horeca_005', 'partner_horeca_003', 'Free Dessert for Two', 'دو افراد کے لیے مفت میٹھا',
   'Complimentary kheer and chai for two.', 'دو افراد کے لیے مفت کھیر اور چائے۔', 150, 350, 140),
  ('offer_horeca_006', 'partner_horeca_004', 'Rs 500 Dining Credit', 'روپے 500 کھانے کا کریڈٹ',
   'Rs 500 off any seekh kebab platter.', 'کسی بھی سیخ کباب پلیٹر پر 500 روپے کی رعایت۔', 400, 500, 200),
  ('offer_horeca_007', 'partner_horeca_004', 'Rs 1,000 Family Meal Credit', 'روپے 1,000 فیملی کھانے کا کریڈٹ',
   'Rs 1,000 off a family BBQ platter.', 'فیملی بار بی کیو پلیٹر پر 1,000 روپے کی رعایت۔', 800, 1000, 400),
  ('offer_horeca_008', 'partner_horeca_005', 'Free Dessert for Two', 'دو افراد کے لیے مفت میٹھا',
   'Complimentary halwa for two guests.', 'دو مہمانوں کے لیے مفت حلوہ۔', 150, 350, 140)
ON CONFLICT ("id") DO NOTHING;

-- Pre-redeemed vouchers so the dashboard tile shows real numbers on first
-- load instead of zeros. Attached to whichever seeded User exists — skipped
-- entirely if there are no users yet (sign up first, then re-run this file).
DO $$
DECLARE
  demo_user_id text;
BEGIN
  SELECT "id" INTO demo_user_id FROM "User" ORDER BY "created_at" ASC LIMIT 1;
  IF demo_user_id IS NULL THEN
    RAISE NOTICE 'No User rows — skipping demo voucher seed. Sign up, then re-run this file.';
    RETURN;
  END IF;

  INSERT INTO "Voucher" ("id", "user_id", "offer_id", "code", "status", "issued_at", "expires_at", "redeemed_at") VALUES
    ('voucher_seed_001', demo_user_id, 'offer_horeca_001', 'K7M4XR29', 'redeemed', now() - interval '9 days',  now() + interval '21 days', now() - interval '7 days'),
    ('voucher_seed_002', demo_user_id, 'offer_horeca_003', 'B8TQ5W3Z', 'redeemed', now() - interval '7 days',  now() + interval '23 days', now() - interval '5 days'),
    ('voucher_seed_003', demo_user_id, 'offer_horeca_002', 'P2HJ6N4V', 'redeemed', now() - interval '5 days',  now() + interval '25 days', now() - interval '4 days'),
    ('voucher_seed_004', demo_user_id, 'offer_horeca_006', 'D9SF3K7Y', 'redeemed', now() - interval '4 days',  now() + interval '26 days', now() - interval '2 days'),
    ('voucher_seed_005', demo_user_id, 'offer_horeca_004', 'M5RC8T2X', 'redeemed', now() - interval '3 days',  now() + interval '27 days', now() - interval '1 day'),
    ('voucher_seed_006', demo_user_id, 'offer_horeca_005', 'W4GB7Y6Q', 'issued',   now() - interval '2 days',  now() + interval '28 days', NULL)
  ON CONFLICT ("id") DO NOTHING;

  -- Keep bulk_credit_issued_pkr consistent with the redeemed vouchers above,
  -- rather than hardcoding a total that could drift out of sync with them.
  UPDATE "Partner" p
  SET "bulk_credit_issued_pkr" = sub.total
  FROM (
    SELECT o."partner_id" AS pid, SUM(o."bulk_credit_pkr") AS total
    FROM "Voucher" v
    JOIN "RewardOffer" o ON o."id" = v."offer_id"
    WHERE v."status" = 'redeemed'
    GROUP BY o."partner_id"
  ) sub
  WHERE p."id" = sub.pid;
END $$;

-- ── Expose the new tables to PostgREST ──────────────────────────────────────
-- Routes call these with the anon key (NEXT_PUBLIC_SUPABASE_ANON_KEY), same as
-- every other REST call in the app.
GRANT SELECT, INSERT, UPDATE ON "Partner"     TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON "RewardOffer" TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON "Voucher"     TO anon, authenticated, service_role;

-- Without this, the three tables stay invisible over REST until PostgREST
-- happens to refresh its schema cache on its own.
NOTIFY pgrst, 'reload schema';
