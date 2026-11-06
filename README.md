# ShelfWatch — AI-Powered Anti-Counterfeit & Inventory Verification

Pakistan's first crowdsourced, AI-powered platform for verifying FMCG product authenticity — built on Next.js 16, Prisma 7, and Vercel serverless functions.

---

### 🚀 Key Integrations & Recent Updates (Hackathon Demo Build)

1. **Passwordless Database Connectivity (Supabase REST API)**:
   * Replaced Prisma Client direct TCP connections in all route handlers with direct HTTPS queries to **Supabase Postgrest REST API**.
   * Completely eliminates Postgres TLS / PgBouncer / Supavisor connection errors and works out of the box with anonymous keys without needing database passwords.
2. **Gemini 3.1 Flash Lite Migration**:
   * Switched LLM vision engines to `gemini-3.1-flash-lite` to resolve rate limits (`429 Quota Exceeded`) on the free tier.
   * Full multi-modal support for logo analysis, packaging layout checks, and brand spellchecking.
3. **Keyless Product Lookup APIs**:
   * Integrated supplement lookups via **Open Food Facts API** and **UPCitemdb API (Free Trial)** inside the verification pipeline.
4. **Enhanced Scan History & Metadata Persistence**:
   * Added `product_name` and `brand_name` cached columns on the `Scan` table, enabling fallback product naming on the **History page** for external lookup items.
5. **Score-Based Verdict Rules**:
   * Added threshold rules for database writes: Score > 70 sets verdict to `genuine`, Score < 40 sets verdict to `suspicious`, otherwise `unverified`.
6. **Mobile Camera Capture**:
   * Added `capture="environment"` to the hidden file input, enabling native mobile camera capture directly when clicking the scan viewfinder.

---

## Quick Start (Development)

```bash
npm install
cp .env.example .env.local   # fill in your keys
npx prisma generate
npx prisma migrate dev --name init
npx prisma db seed
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Backend Setup Guide

### 1 · Database — Neon (Recommended) or Supabase

**Neon (free tier, serverless-native):**
1. Sign up at [neon.tech](https://neon.tech) → Create project `shelfwatch`
2. Copy the **Pooled** connection string → `DATABASE_URL` in `.env.local`
3. Copy the **Direct** connection string → `DIRECT_URL` in `.env.local`
4. In `prisma.config.ts`, the `DATABASE_URL` env var is read automatically

**Supabase alternative:**
- Use the Supabase Postgres connection string with `?pgbouncer=true` for `DATABASE_URL`
- Use the direct connection (port 5432) for `DIRECT_URL`

**Run migrations:**
```bash
npx prisma migrate dev --name init
npx prisma db seed          # seeds brands, products, demo Karachi scan data
```

### 2 · Vercel Blob (Image Storage)

1. In Vercel Dashboard → your project → **Storage** → **Connect Store** → **Blob**
2. The `BLOB_READ_WRITE_TOKEN` env var is automatically added to Vercel
3. For local dev: copy it from Vercel → `.env.local`

### 3 · OCR — Google Cloud Vision

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Enable the **Cloud Vision API**
3. **APIs & Services → Credentials → Create Credentials → API Key**
4. Restrict the key to Cloud Vision API
5. Add to `.env.local`: `GOOGLE_VISION_API_KEY=AIza...`

**Fallback:** Sign up at [ocr.space](https://ocr.space/ocrapi) for a free key → `OCR_SPACE_API_KEY`

### 4 · Computer Vision — Hugging Face

1. Sign up at [huggingface.co](https://huggingface.co) → Settings → Access Tokens
2. Create a token with **read** scope
3. Add to `.env.local`: `HUGGINGFACE_API_KEY=hf_...`

The system uses `openai/clip-vit-large-patch14` for zero-shot packaging classification by default. Override with `HF_MODEL_ID`.

**Fallback:** Sign up at [replicate.com](https://replicate.com) → `REPLICATE_API_KEY=r8_...`

### 5 · Urdu Verdict Phrasing — Anthropic Claude

1. Sign up at [console.anthropic.com](https://console.anthropic.com)
2. Generate an API key
3. Add to `.env.local`: `ANTHROPIC_API_KEY=sk-ant-...`

The verdict Urdu/English text itself is hardcoded (not translated) — Claude only generates the one-sentence reason. The system works without this key (falls back to a default reason string).

### 6 · WhatsApp Cloud API (Webhook)

1. Create a Meta Developer account at [developers.facebook.com](https://developers.facebook.com)
2. Create a new app → Add **WhatsApp** product
3. Go to **WhatsApp → Getting Started**:
   - Copy **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - Generate a **Temporary Access Token** → `WHATSAPP_ACCESS_TOKEN`
4. In **App Settings → Basic** → Copy **App Secret** → `WHATSAPP_APP_SECRET`
5. In **WhatsApp → Configuration → Webhook**:
   - URL: `https://your-app.vercel.app/api/whatsapp-webhook`
   - Verify Token: the string you set in `WHATSAPP_VERIFY_TOKEN`
   - Subscribe to: `messages`

### 7 · National Foods RAG Scraper & Vector Search

National Foods has no public product API (unlike international products,
which use Open Food Facts / UPCitemdb — see §1 above). Instead, ShelfWatch
builds its own reference catalog by scraping National Foods' official
product listings, embedding each product's image with CLIP, and matching
scanned photos against those embeddings via pgvector cosine similarity —
*before* falling back to the standard barcode/OCR pipeline. See
`src/lib/vectorSearch.ts` and `src/app/api/scraper/*`.

**One-time setup:**

1. Run `npx prisma db push` to sync `schema.prisma`'s new fields to your
   database. **If this can't reach your database** (Supabase's connection
   pooler can be finicky to get exactly right locally — see troubleshooting
   below), skip straight to step 2, which does the same thing as plain SQL
   you can paste into the Supabase Dashboard's SQL Editor instead, which
   always works regardless of local connectivity.
2. In the Supabase Dashboard → SQL Editor, run, **in this order**:
   1. `prisma/sql/manual_schema_patch.sql` — adds `Product.source` /
      `last_scraped_at` / `pack_size` and the `ScrapeRun` table. Skip this if
      step 1 already succeeded.
   2. `prisma/sql/pgvector_setup.sql` — creates the `vector` extension, the
      `Product.embedding` column, and the `set_product_embedding` /
      `match_products` RPC functions. Must run after step 2.1 (or after a
      successful `prisma db push`) since it alters the same `Product` table.
3. Add `CRON_SECRET`, and optionally `EMBED_MODEL_ID` / `EMBEDDING_DIM` /
   `VECTOR_MATCH_THRESHOLD`, to your `.env.local` (see `.env.example`).

**Troubleshooting `prisma db push` connectivity:** Supabase's connection
pooler hostname includes a node index (e.g. `aws-1-ap-south-1`, not always
`aws-0`) that varies per project — copy the exact string from the dashboard's
green **Connect** button (not Settings → Database) → **Transaction pooler**
tab, rather than assuming the format. The pooler's transaction-mode port
(6543) doesn't support DDL; use the session-mode port (5432) on the same
host for `prisma db push`/`migrate` specifically. Newer Supabase projects
often don't provision the legacy direct-connection host
(`db.<ref>.supabase.co`) at all — if it doesn't resolve in DNS, that's why,
not a network problem on your end.

**Adding a new scrape source:**

Edit `src/config/scrapeSources.national-foods.json` (or set the
`SCRAPER_SOURCES_JSON` env var to override it without a redeploy). Each
entry is:

```json
{
  "id": "some-unique-id",
  "url": "https://example.com/category-page",
  "enabled": true,
  "selectors": {
    "item": "CSS selector for each product card",
    "name": "CSS selector for the product name, relative to the card",
    "pack_size": "CSS selector for pack size / variant text, or null",
    "image": { "selector": "CSS selector for the <img>", "attr": "src or data-src for lazy-loaded images" },
    "price": "CSS selector for price text, or null"
  }
}
```

Inspect the real page HTML before writing selectors (`curl` the URL, don't
guess) — lazy-loaded sites commonly serve the image URL in `data-src`, not
`src`. Leave `enabled: false` until you've verified the selectors against
real markup; disabled sources are skipped and logged, not scraped.

**Manually triggering a re-scrape or embedding backfill:**

```bash
curl -X POST https://your-app.vercel.app/api/scraper/national-foods \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X POST https://your-app.vercel.app/api/scraper/backfill-embeddings \
  -H "Authorization: Bearer $CRON_SECRET"
```

The scraper also runs automatically via the `vercel.json` cron entry
(weekly, Mondays 3am) — Vercel Cron Jobs trigger via `GET`, which both
routes also accept.

---

## API Reference

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/api/scan` | Upload image + barcode, returns verdict |
| `GET` | `/api/dashboard/stats` | Aggregate stats for a brand |
| `GET` | `/api/dashboard/heatmap` | Geo-clustered hotspot data |
| `POST` | `/api/report` | Consumer one-tap suspicious report |
| `GET` | `/api/whatsapp-webhook` | Meta webhook verification |
| `POST` | `/api/whatsapp-webhook` | Incoming WhatsApp message handler |
| `GET`/`POST` | `/api/scraper/national-foods` | Scrape National Foods listings into the reference catalog (cron + manual) |
| `GET`/`POST` | `/api/scraper/backfill-embeddings` | Generate embeddings for products missing one |

### POST /api/scan

```bash
curl -X POST http://localhost:3000/api/scan \
  -F "image=@product.jpg" \
  -F "barcode=8901030873874" \
  -F "latitude=24.8608" \
  -F "longitude=67.0104" \
  -F "area_name=Saddar Karachi" \
  -F "scanned_by_role=shopkeeper"
```

Response:
```json
{
  "scan_id": "clxyz123",
  "verdict": "genuine",
  "confidence": 0.91,
  "reason": "Batch SEFM-221-KHI matches manufacturer records.",
  "urdu_text": "✅ اصل مصنوع — یہ مصنوع معتبر ہے",
  "english_text": "✅ Genuine Product — This product has been verified as authentic",
  "extracted_batch": "SEFM-221-KHI",
  "brand_name": "Unilever Pakistan",
  "product_name": "Surf Excel Matic Front Load 1kg"
}
```

---

## Deploy to Vercel

```bash
# Push to GitHub, then connect in Vercel dashboard
# Add all env vars from .env.example in Vercel → Project → Settings → Environment Variables
# Vercel auto-builds on push — no Docker required
```

---

## Database Scripts

```bash
npm run db:generate   # regenerate Prisma client after schema changes
npm run db:migrate    # run migrations
npm run db:seed       # seed demo data (brands + products + Karachi scans)
npm run db:studio     # open Prisma Studio GUI
```

---

## Medicine data

Medicines are verified inside the normal scan — there is no separate mode.
A scan is treated as a medicine only on strong evidence: a GS1 DataMatrix with
a serial (21) and expiry (17), a GTIN in the medicine catalogue, or the vision
call reporting a medicine with confidence ≥ 0.8 and at least two pharma cues.
Everything else takes the existing path. `MEDICINE_VERIFICATION_ENABLED=false`
turns the whole feature off.

**1. Create the tables (once).** Run `prisma/sql/medicine_patch.sql` in the
Supabase SQL Editor. It is idempotent and additive only (new nullable Scan
columns, `Medicine` and `DrapAlert` tables, two demo rows). Do not use
`prisma db push --accept-data-loss` or `prisma migrate reset`. Until it runs,
medicine scans still work: the catalogue, alert and clone checks are skipped.

**2. Load the medicine catalogue** from `data/medicines.csv`:

```
registration_no,brand_name,generic_name,strength,dosage_form,manufacturer,gtin
```

```bash
npm run medicines:import                 # data/medicines.csv
npm run medicines:import path/to/my.csv  # or another file
```

Rows are matched on `gtin`, then `registration_no`, and updated in place, so
re-running is safe. GTINs are stored as GTIN-14 and must pass the check digit;
registration numbers are stored as the 6-digit DRAP number.

**3. Load DRAP alerts** (falsified / substandard / recall notices) from
`data/drap-alerts.csv`:

```
product_name,generic_name,batch_no,manufacturer_claimed,alert_type,alert_date,source_url
```

```bash
npm run alerts:import
```

`alert_type` is `falsified`, `substandard` or `recall`; `alert_date` is
`YYYY-MM-DD`. Batches are normalised exactly as the scan-time check compares
them (uppercase, no spaces / `-` / `/`, O→0, I→1, S→5). Use
`source_url = demo` for test rows. Both scripts print inserted / updated /
unchanged / skipped counts and need `SUPABASE_SERVICE_ROLE_KEY`.

The bundled CSVs hold **demo rows only** (`DEMO …` names, GTINs in the 200
restricted-circulation range, Reg. Nos. 999901–999905). Replace them with real
DRAP data before relying on the results. No DRAP scraper runs automatically.

**Checks** (`src/services/medicineChecks.ts`, one CheckResult each): GTIN
check digit, expiry, mfg vs expiry, 2D-code batch and expiry vs the print,
pharma packaging inspection, cloned serial (same GTIN + serial in another area
or > `MEDICINE_CLONE_DISTANCE_KM`), DRAP registration, GTIN catalogue, DRAP
alerts, and an optional GS1 / DRAP registry (`GS1_VERIFY_API_KEY` +
`DRAP_TT_API_URL`). The verdict is combined in `combineMedicineVerdict`
(`src/services/scoreEngine.ts`). A medicine is never shown as "genuine": the
best result reads "No red flags found. Confirm with your pharmacist."

```bash
npm test   # unit tests: GS1 parser, every check, the combiner, routing
```

---

## Architecture

```
Browser / PWA
    │
    ▼
Next.js App Router (Vercel Edge / Serverless)
    │
    ├── /api/scan ──────────────────────────────────────────────────────┐
    │       │                                                           │
    │       ▼                                                           │
    │   lib/verifyProduct.ts (shared pipeline)                         │
    │       ├── Vercel Blob (image upload)                             │
    │       ├── lib/ocr.ts → Google Cloud Vision API                   │
    │       ├── lib/cv.ts  → Hugging Face Inference API                │
    │       ├── Prisma → Neon/Supabase Postgres (lookup + write)       │
    │       └── lib/translate.ts → Anthropic Claude (reason)          │
    │                                                                   │
    ├── /api/dashboard/stats ─────────────────────────────────────────┤
    ├── /api/dashboard/heatmap ───────────────────────────────────────┤
    ├── /api/report ──────────────────────────────────────────────────┤
    └── /api/whatsapp-webhook ──────────────────────────────────────── same pipeline ┘
```
