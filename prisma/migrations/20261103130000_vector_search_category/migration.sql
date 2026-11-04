-- Hand-written: Prisma doesn't manage SQL functions.
--
-- match_products gains a category filter so medicine reference images (from
-- the pharma scrapers) can never match a food scan, or the other way round.
-- It defaults to 'fmcg', the category every pre-existing row has, so callers
-- that don't pass it keep exactly the results they had before this migration.
--
-- Dropped and recreated rather than overloaded: two versions would make
-- PostgREST's named-argument call ambiguous.
DROP FUNCTION IF EXISTS match_products(vector, float, text, int);

CREATE OR REPLACE FUNCTION match_products(
  query_embedding vector(512),
  match_threshold float DEFAULT 0.85,
  brand_filter text DEFAULT NULL,
  match_count int DEFAULT 1,
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

NOTIFY pgrst, 'reload schema';
