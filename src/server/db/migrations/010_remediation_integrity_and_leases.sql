-- AIXSHOP v1.0 — Migration 010: Remediation Integrity, Unique Deduplication & Worker Leases (010_remediation_integrity_and_leases.sql)
-- 1. Enforces workspace-scoped composite parent lineage on shopify_sync_runs.
-- 2. Adds dedicated webhook verification timestamp, status, and diagnostic details on shopify_connections.
-- 3. Adds server-side verification provenance columns to workspace_business_profiles & normalizes legacy self-verified status.
-- 4. Safely deduplicates ai_visibility_metrics and creates unique constraint matching repository ON CONFLICT target, plus import status/error tracking.
-- 5. Adds durable lease ownership, expiration, and attempt_count columns to billing_events.

-- =========================================================================
-- Step 1: Workspace-scoped composite parent lineage on shopify_sync_runs
-- =========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_shopify_sync_runs_workspace_id'
      AND conrelid = 'shopify_sync_runs'::regclass
  ) THEN
    ALTER TABLE shopify_sync_runs
      ADD CONSTRAINT uq_shopify_sync_runs_workspace_id UNIQUE (workspace_id, id);
  END IF;

  -- Null out any anomalous cross-workspace parent references if any ever existed before attaching composite FK
  UPDATE shopify_sync_runs c
  SET parent_sync_run_id = NULL
  WHERE c.parent_sync_run_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM shopify_sync_runs p
      WHERE p.id = c.parent_sync_run_id AND p.workspace_id = c.workspace_id
    );

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_shopify_sync_runs_parent_workspace'
      AND conrelid = 'shopify_sync_runs'::regclass
  ) THEN
    ALTER TABLE shopify_sync_runs
      ADD CONSTRAINT fk_shopify_sync_runs_parent_workspace
      FOREIGN KEY (workspace_id, parent_sync_run_id)
      REFERENCES shopify_sync_runs(workspace_id, id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shopify_sync_runs_ws_parent
  ON shopify_sync_runs(workspace_id, parent_sync_run_id);

-- =========================================================================
-- Step 2: Dedicated webhook verification columns on shopify_connections
-- =========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'shopify_connections' AND column_name = 'webhook_last_verified_at'
  ) THEN
    ALTER TABLE shopify_connections ADD COLUMN webhook_last_verified_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'shopify_connections' AND column_name = 'webhook_verification_status'
  ) THEN
    ALTER TABLE shopify_connections ADD COLUMN webhook_verification_status VARCHAR(64) NOT NULL DEFAULT 'not_configured';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'shopify_connections' AND column_name = 'webhook_verification_details'
  ) THEN
    ALTER TABLE shopify_connections ADD COLUMN webhook_verification_details JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- =========================================================================
-- Step 3: Business Profile verification provenance & status normalization
-- =========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workspace_business_profiles' AND column_name = 'verification_source'
  ) THEN
    ALTER TABLE workspace_business_profiles ADD COLUMN verification_source VARCHAR(128);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workspace_business_profiles' AND column_name = 'verification_evidence_json'
  ) THEN
    ALTER TABLE workspace_business_profiles ADD COLUMN verification_evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- Downgrade any historical self-declared 'merchant_verified' rows so they are never mistaken for independent verification
UPDATE workspace_business_profiles
SET verification_status = 'merchant_self_declared',
    last_verified_at = NULL
WHERE verification_status = 'merchant_verified';

UPDATE workspace_business_profiles
SET verification_status = 'not_verified'
WHERE verification_status = 'unverified';

ALTER TABLE workspace_business_profiles
  ALTER COLUMN verification_status SET DEFAULT 'not_verified';

-- =========================================================================
-- Step 4: Safe deduplication & UNIQUE constraint on ai_visibility_metrics
-- =========================================================================
-- Normalize NULL discovery_topic values to '' first
UPDATE ai_visibility_metrics
SET discovery_topic = ''
WHERE discovery_topic IS NULL;

ALTER TABLE ai_visibility_metrics
  ALTER COLUMN discovery_topic SET DEFAULT '';

ALTER TABLE ai_visibility_metrics
  ALTER COLUMN discovery_topic SET NOT NULL;

-- Safely merge any existing duplicate observations without losing historical totals
WITH ranked AS (
  SELECT
    id,
    workspace_id,
    observation_date,
    platform,
    discovery_topic,
    SUM(brand_mentions) OVER (PARTITION BY workspace_id, observation_date, platform, discovery_topic) AS total_brand,
    SUM(product_mentions) OVER (PARTITION BY workspace_id, observation_date, platform, discovery_topic) AS total_product,
    SUM(website_clicks) OVER (PARTITION BY workspace_id, observation_date, platform, discovery_topic) AS total_clicks,
    ROW_NUMBER() OVER (
      PARTITION BY workspace_id, observation_date, platform, discovery_topic
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM ai_visibility_metrics
),
merged_keepers AS (
  UPDATE ai_visibility_metrics m
  SET
    brand_mentions = r.total_brand,
    product_mentions = r.total_product,
    website_clicks = r.total_clicks
  FROM ranked r
  WHERE m.id = r.id
    AND r.rn = 1
    AND (m.brand_mentions <> r.total_brand OR m.product_mentions <> r.total_product OR m.website_clicks <> r.total_clicks)
  RETURNING m.id
)
DELETE FROM ai_visibility_metrics m
USING ranked r
WHERE m.id = r.id
  AND r.rn > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_ai_visibility_metric_key'
      AND conrelid = 'ai_visibility_metrics'::regclass
  ) THEN
    ALTER TABLE ai_visibility_metrics
      ADD CONSTRAINT uq_ai_visibility_metric_key
      UNIQUE (workspace_id, observation_date, platform, discovery_topic);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_visibility_imports' AND column_name = 'status'
  ) THEN
    ALTER TABLE ai_visibility_imports ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'completed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_visibility_imports' AND column_name = 'rejected_row_count'
  ) THEN
    ALTER TABLE ai_visibility_imports ADD COLUMN rejected_row_count INTEGER NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_visibility_imports' AND column_name = 'errors_json'
  ) THEN
    ALTER TABLE ai_visibility_imports ADD COLUMN errors_json JSONB NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- =========================================================================
-- Step 5: Durable lease ownership columns on billing_events
-- =========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_events' AND column_name = 'lease_owner'
  ) THEN
    ALTER TABLE billing_events ADD COLUMN lease_owner VARCHAR(128);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_events' AND column_name = 'lease_expires_at'
  ) THEN
    ALTER TABLE billing_events ADD COLUMN lease_expires_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'billing_events' AND column_name = 'attempt_count'
  ) THEN
    ALTER TABLE billing_events ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_billing_events_lease
  ON billing_events(status, lease_expires_at);
