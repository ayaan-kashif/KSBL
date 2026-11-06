-- ─────────────────────────────────────────────────────────────────────────────
-- Medicine verification v2 — idempotent, additive-only schema patch.
--
-- Run in the Supabase SQL Editor (or psql). Safe to run any number of times:
-- every statement is CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS. Nothing
-- is renamed, retyped or dropped, and the Verdict enum is untouched.
--
-- The app works before AND after this runs: medicine scans retry their insert
-- without the new Scan columns if they are missing (lib/scanInsert.ts), and
-- the catalogue / alert / clone checks are simply skipped until the tables
-- exist. Food/FMCG inserts never send these columns at all.
--
-- Do NOT use `prisma db push --accept-data-loss` or `prisma migrate reset`.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Scan: nullable medicine columns ──────────────────────────────────────────
ALTER TABLE "Scan" ADD COLUMN IF NOT EXISTS "product_type" text DEFAULT 'fmcg';
ALTER TABLE "Scan" ADD COLUMN IF NOT EXISTS "gs1_serial" text;
ALTER TABLE "Scan" ADD COLUMN IF NOT EXISTS "gs1_expiry" date;
ALTER TABLE "Scan" ADD COLUMN IF NOT EXISTS "gs1_batch" text;
ALTER TABLE "Scan" ADD COLUMN IF NOT EXISTS "registration_no" text;
CREATE INDEX IF NOT EXISTS "Scan_barcode_gs1_serial_idx" ON "Scan" ("barcode", "gs1_serial");

-- ── Medicine catalogue ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Medicine" (
  "id"              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "gtin"            text,
  "registration_no" text,
  "brand_name"      text NOT NULL,
  "generic_name"    text,
  "strength"        text,
  "dosage_form"     text,
  "manufacturer"    text,
  "created_at"      timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "Medicine_gtin_key" ON "Medicine" ("gtin");
CREATE INDEX IF NOT EXISTS "Medicine_registration_no_idx" ON "Medicine" ("registration_no");

-- ── DRAP alerts ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DrapAlert" (
  "id"                   text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "product_name"         text NOT NULL,
  "generic_name"         text,
  "batch_no"             text NOT NULL,
  "batch_norm"           text NOT NULL,
  "manufacturer_claimed" text,
  "alert_type"           text NOT NULL,
  "alert_date"           date NOT NULL,
  "source_url"           text NOT NULL,
  "created_at"           timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "DrapAlert_batch_norm_product_name_key" ON "DrapAlert" ("batch_norm", "product_name");
CREATE INDEX IF NOT EXISTS "DrapAlert_batch_norm_idx" ON "DrapAlert" ("batch_norm");

-- ── Access: public reference data, read-only to the app's anon key ───────────
-- Writes come only from the import scripts, which use the service role key
-- (it bypasses RLS). anon/authenticated can read, nobody else can write.
ALTER TABLE "Medicine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DrapAlert" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'Medicine' AND policyname = 'Medicine read') THEN
    CREATE POLICY "Medicine read" ON "Medicine" FOR SELECT TO anon, authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'DrapAlert' AND policyname = 'DrapAlert read') THEN
    CREATE POLICY "DrapAlert read" ON "DrapAlert" FOR SELECT TO anon, authenticated USING (true);
  END IF;
END $$;

-- ── Demo rows (clearly marked; safe to delete) ───────────────────────────────
-- GTINs use the 200–299 restricted-circulation prefix range, so they can never
-- collide with a real product; registration numbers 999901–999905 are demo.
INSERT INTO "Medicine" ("gtin", "registration_no", "brand_name", "generic_name", "strength", "dosage_form", "manufacturer")
VALUES
  ('02000000000015', '999901', 'DEMO Paracetol', 'Paracetamol', '500 mg', 'Tablet', 'Demo Pharma (Pvt) Ltd'),
  ('02000000000022', '999902', 'DEMO Amoxil-D', 'Amoxicillin', '250 mg', 'Capsule', 'Demo Pharma (Pvt) Ltd')
ON CONFLICT ("gtin") DO NOTHING;

INSERT INTO "DrapAlert" ("product_name", "generic_name", "batch_no", "batch_norm", "manufacturer_claimed", "alert_type", "alert_date", "source_url")
VALUES
  ('DEMO Paracetol', 'Paracetamol', 'FAKE-001', 'FAKE001', 'Demo Pharma (Pvt) Ltd', 'falsified', '2026-10-01', 'demo')
ON CONFLICT ("batch_norm", "product_name") DO NOTHING;

-- PostgREST picks up the new tables/columns on its next schema reload.
NOTIFY pgrst, 'reload schema';
