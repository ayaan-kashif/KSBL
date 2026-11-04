-- ─────────────────────────────────────────────────────────────────────────────
-- pgvector setup — RUN AFTER prisma/sql/manual_schema_patch.sql
--
-- Creates the two RPC functions src/lib/vectorSearch.ts calls over PostgREST
-- (Prisma Client can't query/write "Unsupported(vector(512))" columns, and
-- the pgvector `<=>` cosine-distance ORDER BY can't be expressed through
-- plain PostgREST query params — hence RPC functions instead of REST filters).
--
-- The "vector" extension itself is declared in schema.prisma's datasource
-- (`extensions = [vector]`) and gets created by `prisma db push`/`migrate` —
-- the CREATE EXTENSION below is just a defensive no-op if run standalone.
--
-- Embedding dimension is 512, matching:
--   - schema.prisma: Product.embedding Unsupported("vector(512)")?
--   - src/lib/embeddings.ts DEFAULT_EMBEDDING_DIM / EMBED_MODEL_ID
--     (openai/clip-vit-base-patch32 outputs 512-dim vectors)
-- If you ever change EMBED_MODEL_ID to a model with a different output size,
-- update EMBEDDING_DIM *and* both `vector(512)` references below to match.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;

-- ── match_products: cosine-similarity search ────────────────────────────────
-- Called from src/lib/vectorSearch.ts findProductByImage() as:
--   rpc/match_products { query_embedding, match_threshold, brand_filter, match_count }
-- Returns product columns + a "similarity" column (1 - cosine_distance, so
-- higher = more similar, matching VECTOR_MATCH_THRESHOLD's "higher = stricter"
-- semantics).
-- Drop the 4-argument version first; see migration 20261103130000.
DROP FUNCTION IF EXISTS match_products(vector, float, text, int);

CREATE OR REPLACE FUNCTION match_products(
  query_embedding vector(512),
  match_threshold float DEFAULT 0.85,
  brand_filter text DEFAULT NULL,
  match_count int DEFAULT 1,
  -- Added by migration 20261103130000_vector_search_category: medicine rows
  -- never match food scans. Defaults to the category of every food row.
  category_filter text DEFAULT 'fmcg'
)
RETURNS TABLE (
  id text,
  sku text,
  brand_name text,
  product_name text,
  reference_batch_pattern text,
  reference_image_url text,
  avg_unit_price_pkr float,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    p.id,
    p.sku,
    p.brand_name,
    p.product_name,
    p.reference_batch_pattern,
    p.reference_image_url,
    p.avg_unit_price_pkr,
    1 - (p.embedding <=> query_embedding) AS similarity
  FROM "Product" p
  WHERE p.embedding IS NOT NULL
    AND (brand_filter IS NULL OR p.brand_name = brand_filter)
    AND (category_filter IS NULL OR p.category = category_filter)
    AND 1 - (p.embedding <=> query_embedding) >= match_threshold
  ORDER BY p.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── set_product_embedding: write/overwrite a product's embedding ───────────
-- Called from src/lib/vectorSearch.ts setProductEmbedding(), used by the
-- scraper (src/app/api/scraper/national-foods/route.ts) and the backfill
-- route (src/app/api/scraper/backfill-embeddings/route.ts).
CREATE OR REPLACE FUNCTION set_product_embedding(
  p_id text,
  p_embedding vector(512)
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE "Product" SET embedding = p_embedding WHERE id = p_id;
$$;

-- ── Expose both functions to PostgREST ──────────────────────────────────────
-- These are called with the anon key (see NEXT_PUBLIC_SUPABASE_ANON_KEY usage
-- in vectorSearch.ts), so the anon role needs EXECUTE.
GRANT EXECUTE ON FUNCTION match_products(vector, float, text, int) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION set_product_embedding(text, vector) TO anon, authenticated, service_role;

-- Ask PostgREST to pick up the new functions immediately instead of waiting
-- for its next schema-cache refresh.
NOTIFY pgrst, 'reload schema';
