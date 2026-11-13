-- AIXSHOP v1.0 — Migration 009: Durable Sync Runs & AI Discovery Readiness Schema (009_durable_sync_runs_and_ai_discovery.sql)
-- 1. Enhances shopify_sync_runs with parent-attempt lineage, variant completeness status, and pagination metadata.
-- 2. Creates workspace_business_profiles for authoritative brand and commerce entity readiness.
-- 3. Creates ai_visibility_imports and ai_visibility_metrics for evidence-backed discovery monitoring.

-- Step 1: Add durable sync run columns to shopify_sync_runs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shopify_sync_runs' AND column_name = 'parent_sync_run_id'
  ) THEN
    ALTER TABLE shopify_sync_runs ADD COLUMN parent_sync_run_id VARCHAR(64) REFERENCES shopify_sync_runs(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shopify_sync_runs' AND column_name = 'attempt_number'
  ) THEN
    ALTER TABLE shopify_sync_runs ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shopify_sync_runs' AND column_name = 'variant_completeness_status'
  ) THEN
    ALTER TABLE shopify_sync_runs ADD COLUMN variant_completeness_status VARCHAR(64) DEFAULT 'complete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shopify_sync_runs' AND column_name = 'variant_completeness_json'
  ) THEN
    ALTER TABLE shopify_sync_runs ADD COLUMN variant_completeness_json JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shopify_sync_runs' AND column_name = 'pagination_metadata_json'
  ) THEN
    ALTER TABLE shopify_sync_runs ADD COLUMN pagination_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shopify_sync_runs_parent ON shopify_sync_runs(parent_sync_run_id);
CREATE INDEX IF NOT EXISTS idx_shopify_sync_runs_ws_status ON shopify_sync_runs(workspace_id, status);

-- Step 2: Create workspace_business_profiles for Brand & Business Information Readiness
CREATE TABLE IF NOT EXISTS workspace_business_profiles (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  legal_business_name VARCHAR(255),
  public_brand_name VARCHAR(255),
  brand_description TEXT,
  official_website VARCHAR(512),
  primary_domain VARCHAR(255),
  contact_email VARCHAR(255),
  contact_phone VARCHAR(64),
  business_address TEXT,
  support_url VARCHAR(512),
  shipping_policy_url VARCHAR(512),
  return_policy_url VARCHAR(512),
  refund_policy_url VARCHAR(512),
  privacy_policy_url VARCHAR(512),
  terms_of_service_url VARCHAR(512),
  logo_url VARCHAR(512),
  social_profiles_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification_status VARCHAR(64) NOT NULL DEFAULT 'unverified',
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_workspace_business_profile UNIQUE (workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_business_profiles_ws ON workspace_business_profiles(workspace_id);

-- Step 3: Create ai_visibility_imports for traceable merchant analytics data
CREATE TABLE IF NOT EXISTS ai_visibility_imports (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  reporting_period_start DATE,
  reporting_period_end DATE,
  source_platform VARCHAR(128) NOT NULL DEFAULT 'merchant_upload',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_visibility_imports_ws ON ai_visibility_imports(workspace_id, created_at DESC);

-- Step 4: Create ai_visibility_metrics for evidence-backed discovery observations
CREATE TABLE IF NOT EXISTS ai_visibility_metrics (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  import_id VARCHAR(64) REFERENCES ai_visibility_imports(id) ON DELETE CASCADE,
  observation_date DATE NOT NULL,
  platform VARCHAR(64) NOT NULL,
  brand_mentions INTEGER NOT NULL DEFAULT 0,
  product_mentions INTEGER NOT NULL DEFAULT 0,
  website_clicks INTEGER NOT NULL DEFAULT 0,
  discovery_topic VARCHAR(255),
  evidence_source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_visibility_metrics_ws_date ON ai_visibility_metrics(workspace_id, observation_date DESC);
CREATE INDEX IF NOT EXISTS idx_ai_visibility_metrics_import ON ai_visibility_metrics(import_id);
