-- AIXSHOP v1.0 — Migration 016: Traceable Catalog Source Classification & Fake Domain Cleanup
-- Forward-only schema evolution preserving all applied history in Migrations 001–015.

-- 1. Add source classification, website_url, Shopify OAuth status, and audit telemetry columns to stores
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS website_url VARCHAR(512) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS platform VARCHAR(255),
  ADD COLUMN IF NOT EXISTS source_classification VARCHAR(64) NOT NULL DEFAULT 'unconfigured',
  ADD COLUMN IF NOT EXISTS source_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence_coverage_avg INTEGER,
  ADD COLUMN IF NOT EXISTS last_audit_date VARCHAR(64),
  ADD COLUMN IF NOT EXISTS shopify_connected BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS shopify_shop_domain VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_stores_source_classification
  ON stores(workspace_id, source_classification);

-- 2. Add traceable source classification columns to products
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS source_classification VARCHAR(64),
  ADD COLUMN IF NOT EXISTS source_origin VARCHAR(512),
  ADD COLUMN IF NOT EXISTS acquisition_method VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_products_source_classification
  ON products(workspace_id, source_classification);

-- 3. Reconcile active Shopify OAuth connections from server-managed shopify_connections
UPDATE stores s
SET
  shopify_connected = TRUE,
  shopify_shop_domain = sc.shop_domain,
  source_classification = 'shopify_oauth',
  platform = COALESCE(NULLIF(s.platform, ''), 'Shopify Admin GraphQL API (2026-10)')
FROM shopify_connections sc
WHERE sc.workspace_id = s.workspace_id
  AND sc.status = 'connected'
  AND sc.shop_domain IS NOT NULL
  AND sc.shop_domain <> '';

-- 4. Remove ONLY unbacked fabricated synthetic .myshopify.com defaults while preserving genuine merchant domains
UPDATE stores s
SET
  domain = '',
  website_url = '',
  shopify_connected = FALSE,
  shopify_shop_domain = NULL
FROM workspaces w
WHERE w.id = s.workspace_id
  AND NOT EXISTS (
    SELECT 1
    FROM shopify_connections sc
    WHERE sc.workspace_id = s.workspace_id
      AND sc.status = 'connected'
  )
  AND (
    LOWER(TRIM(s.domain)) = LOWER(w.slug || '.myshopify.com')
    OR LOWER(TRIM(s.domain)) = LOWER(w.id || '.myshopify.com')
    OR LOWER(TRIM(s.domain)) = 'store.myshopify.com'
  );

-- 5. Preserve non-empty merchant website domains in website_url
UPDATE stores
SET website_url = domain
WHERE (website_url IS NULL OR website_url = '')
  AND domain IS NOT NULL
  AND domain <> '';

-- 6. Backfill traceable source metadata on existing products
UPDATE products p
SET
  source_classification = 'shopify_oauth',
  source_origin = COALESCE(NULLIF(p.source_origin, ''), spp.shop_domain),
  acquisition_method = COALESCE(
    NULLIF(p.acquisition_method, ''),
    CASE
      WHEN spp.source_type = 'shopify_webhook' THEN 'shopify_webhook'
      ELSE 'shopify_admin_graphql'
    END
  )
FROM shopify_product_provenance spp
WHERE spp.workspace_id = p.workspace_id
  AND spp.product_id = p.id
  AND p.source_classification IS NULL;

UPDATE products p
SET
  source_classification = CASE
    WHEN p.id LIKE 'prod_solstice_%' THEN 'demo'
    WHEN (p.attributes_json->>'provenance') = 'observed_in_sample'
      OR (p.attributes_json->>'sourcePlatform') IN ('public_products_json', 'shopify') THEN 'public_feed'
    ELSE 'manual_import'
  END,
  acquisition_method = COALESCE(
    NULLIF(p.acquisition_method, ''),
    CASE
      WHEN p.id LIKE 'prod_solstice_%' THEN 'demo_fixture'
      WHEN (p.attributes_json->>'provenance') = 'observed_in_sample'
        OR (p.attributes_json->>'sourcePlatform') IN ('public_products_json', 'shopify') THEN 'public_products_json_sample'
      ELSE 'manual_import'
    END
  )
WHERE p.source_classification IS NULL;

-- 7. Backfill store-level source_classification for existing workspaces without overwriting shopify_oauth
UPDATE stores s
SET source_classification = CASE
  WHEN EXISTS (
    SELECT 1 FROM products p WHERE p.workspace_id = s.workspace_id AND p.source_classification = 'demo'
  ) THEN 'demo'
  WHEN EXISTS (
    SELECT 1 FROM products p WHERE p.workspace_id = s.workspace_id AND p.source_classification = 'public_feed'
  ) THEN 'public_feed'
  WHEN EXISTS (
    SELECT 1 FROM products p WHERE p.workspace_id = s.workspace_id
  ) THEN 'manual_import'
  ELSE 'unconfigured'
END
WHERE s.source_classification = 'unconfigured';
