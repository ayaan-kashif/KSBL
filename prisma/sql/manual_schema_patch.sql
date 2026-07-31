-- ─────────────────────────────────────────────────────────────────────────────
-- Manual schema patch — RUN THIS FIRST, before prisma/sql/pgvector_setup.sql
--
-- Normally these changes come from `npx prisma db push` (schema.prisma is the
-- source of truth). This file exists as a fallback for running the same
-- changes directly in the Supabase SQL Editor, for cases where the CLI can't
-- reach the database (pooler/DDL connectivity issues) but the SQL Editor can.
--
-- If you later get `prisma db push` working against this database, running it
-- is idempotent against this file's changes (IF NOT EXISTS everywhere) — no
-- conflict either way.
--
-- IMPORTANT: writes in this app go through the Supabase REST API (PostgREST),
-- not Prisma Client — so a plain `@default(cuid())` on an "id" column NEVER
-- actually fires at the database level (cuid() is a Prisma Client-side
-- behavior, not a Postgres default). ScrapeRun, Scan, and Report all need (and,
-- as of schema.prisma, now declare via `@default(dbgenerated(...))`) an actual
-- `DEFAULT gen_random_uuid()::text` so REST inserts that omit "id" (as
-- src/app/api/scraper/national-foods/route.ts, src/app/api/verify/route.ts,
-- and src/app/api/report/route.ts all do) still work. gen_random_uuid() is
-- built into Postgres 13+ (Supabase's Postgres qualifies — no extra extension
-- needed).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Product: new columns ────────────────────────────────────────────────────
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "pack_size" text;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'manual';
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "last_scraped_at" timestamp(3);
-- "embedding" (vector(512)) is added by pgvector_setup.sql, which also creates
-- the "vector" extension this column type depends on — run that file next.

CREATE INDEX IF NOT EXISTS "Product_source_idx" ON "Product"("source");

-- ── ScrapeRun: new table + enum ─────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ScrapeRunStatus" AS ENUM ('running', 'success', 'partial_failure', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ScrapeRun" (
  "id"               text NOT NULL DEFAULT gen_random_uuid()::text,
  "source"           text NOT NULL,
  "status"           "ScrapeRunStatus" NOT NULL DEFAULT 'running',
  "products_found"   integer NOT NULL DEFAULT 0,
  "products_created" integer NOT NULL DEFAULT 0,
  "products_updated" integer NOT NULL DEFAULT 0,
  "products_failed"  integer NOT NULL DEFAULT 0,
  "error_log"        jsonb,
  "started_at"       timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"      timestamp(3),
  CONSTRAINT "ScrapeRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ScrapeRun_source_idx" ON "ScrapeRun"("source");
CREATE INDEX IF NOT EXISTS "ScrapeRun_status_idx" ON "ScrapeRun"("status");

-- ── Scan / Report: give "id" the same DB-level default as ScrapeRun above ───
-- src/app/api/verify/route.ts (real product scans) and src/app/api/report/route.ts
-- + src/app/api/incidents/[id]/flag/route.ts (incident reports) all insert via
-- the REST API without an "id". Without this default every one of those
-- inserts fails with "null value in column \"id\" ... violates not-null
-- constraint" — silently, since those routes log the DB error and still
-- return a success response to the client. This was the cause of the
-- dashboard/analytics "Recent Scans" table only ever showing seeded demo
-- rows and never real scans.
--
-- UPDATE: this is now also declared directly in schema.prisma as
-- `@default(dbgenerated("gen_random_uuid()::text"))` on Scan.id, Report.id,
-- and ScrapeRun.id (instead of only existing as an out-of-band default only
-- this file knew about). That matters because `db push` treats any DB default
-- schema.prisma doesn't know about as unwanted drift and SILENTLY DROPS it —
-- which is exactly what happened here once, wiping this fix out again right
-- after it was applied. With the default declared in schema.prisma, `db push`
-- preserves it instead. These ALTERs stay here only as the SQL-Editor fallback
-- path described at the top of this file.
ALTER TABLE "Scan" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;
ALTER TABLE "Report" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;

-- ── Scan: created_at needs a UTC offset in its wire format ──────────────────
-- "timestamp without time zone" holds a UTC instant here (CURRENT_TIMESTAMP
-- under a UTC DB session) but PostgREST serializes it with no "Z"/offset, so
-- the browser's `new Date(row.created_at)` misparses it as local time instead
-- of UTC — every scan's displayed time was off by the viewer's UTC offset.
-- timestamptz makes PostgREST include the offset, fixing that at the source.
ALTER TABLE "Scan" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';
ALTER TABLE "Scan" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;

-- ── Sanity check: confirm whether Product/Scan/Report already have a DB-level
-- id default (they should, for existing REST-insert routes like
-- /api/products, /api/scan to have ever worked) — if this returns no rows /
-- null, those routes have been relying on Postgres allowing a NULL then
-- erroring, which would mean they're currently broken too. Worth a look:
--
-- select table_name, column_name, column_default
-- from information_schema.columns
-- where table_name in ('Product', 'Scan', 'Report') and column_name = 'id';

-- ── Product.id default ──────────────────────────────────────────────────────
-- Added after scripts/import-reference-images.mjs hit "null value in column
-- id" (23502). Product was the one table still relying solely on Prisma's
-- client-side @default(cuid()), which never fires for the REST inserts used by
-- the scraper and the reference-image importer. Declared in schema.prisma too,
-- so `prisma db push` doesn't drop it as drift.
ALTER TABLE "Product" ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
