-- AIXSHOP v1.0 — Migration 010: Remediation Integrity, Unique Constraints & Worker Leases (010_remediation_integrity_and_leases.sql)
-- Schema Contract:
--   All table/column/constraint checks bind strictly to current_schema() per PostgreSQL search_path.
--   Requires target application schema (default: public, or custom single-tenant app schema) to be the
--   first schema in search_path at migration time. Never matches across unrelated schemas.
-- 1. Enforces workspace-scoped composite parent lineage on shopify_sync_runs with definition validation.
-- 2. Adds dedicated webhook verification timestamp, status, and diagnostic details on shopify_connections.
-- 3. Adds server-side verification provenance columns to workspace_business_profiles & normalizes legacy self-verified status.
-- 4. Non-destructively verifies absence of ambiguous ai_visibility_metrics duplicates before attaching uq_ai_visibility_metric_key.
-- 5. Adds durable lease ownership, expiration, and attempt_count columns to billing_events.

-- =========================================================================
-- Step 1: Workspace-scoped composite parent lineage on shopify_sync_runs
-- =========================================================================
DO $$
DECLARE
  v_contype char;
  v_src_tbl text;
  v_tgt_tbl text;
  v_src_schema text;
  v_tgt_schema text;
  v_src_cols text[];
  v_tgt_cols text[];
  v_is_unique boolean;
  v_has_pred boolean;
BEGIN
  -- 1a. Validate or create UNIQUE (workspace_id, id) on shopify_sync_runs in current_schema()
  SELECT
    c.contype,
    t.relname,
    n.nspname,
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[]),
    COALESCE(idx.indisunique, false),
    (idx.indpred IS NOT NULL)
  INTO
    v_contype,
    v_src_tbl,
    v_src_schema,
    v_src_cols,
    v_is_unique,
    v_has_pred
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
  LEFT JOIN pg_index idx ON idx.indexrelid = c.conindid
  WHERE c.conname = 'uq_shopify_sync_runs_workspace_id'
    AND n.nspname = current_schema();

  IF FOUND THEN
    IF v_contype NOT IN ('u', 'p')
       OR v_src_tbl IS DISTINCT FROM 'shopify_sync_runs'
       OR v_src_schema IS DISTINCT FROM current_schema()
       OR v_src_cols IS DISTINCT FROM ARRAY['workspace_id', 'id']
       OR v_is_unique IS DISTINCT FROM true
       OR v_has_pred IS DISTINCT FROM false THEN
      RAISE EXCEPTION '[AIXSHOP Migration 010 Error] Incompatible constraint "uq_shopify_sync_runs_workspace_id" already exists (table: %.%, type: %, columns: %, unique: %, partial: %). Expected non-partial UNIQUE shopify_sync_runs(workspace_id, id).',
        v_src_schema, v_src_tbl, v_contype, v_src_cols, v_is_unique, v_has_pred;
    END IF;
  ELSE
    ALTER TABLE shopify_sync_runs
      ADD CONSTRAINT uq_shopify_sync_runs_workspace_id UNIQUE (workspace_id, id);
  END IF;

  -- Null out any anomalous cross-workspace parent references before attaching composite FK
  UPDATE shopify_sync_runs c
  SET parent_sync_run_id = NULL
  WHERE c.parent_sync_run_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM shopify_sync_runs p
      WHERE p.id = c.parent_sync_run_id AND p.workspace_id = c.workspace_id
    );

  -- 1b. Validate or create composite FK (workspace_id, parent_sync_run_id) -> shopify_sync_runs(workspace_id, id)
  SELECT
    c.contype,
    src_t.relname,
    tgt_t.relname,
    src_ns.nspname,
    tgt_ns.nspname,
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[]),
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.confrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[])
  INTO
    v_contype,
    v_src_tbl,
    v_tgt_tbl,
    v_src_schema,
    v_tgt_schema,
    v_src_cols,
    v_tgt_cols
  FROM pg_constraint c
  JOIN pg_class src_t ON c.conrelid = src_t.oid
  JOIN pg_namespace src_ns ON src_t.relnamespace = src_ns.oid
  LEFT JOIN pg_class tgt_t ON c.confrelid = tgt_t.oid
  LEFT JOIN pg_namespace tgt_ns ON tgt_t.relnamespace = tgt_ns.oid
  WHERE c.conname = 'fk_shopify_sync_runs_parent_workspace'
    AND src_ns.nspname = current_schema();

  IF FOUND THEN
    IF v_contype IS DISTINCT FROM 'f'
       OR v_src_tbl IS DISTINCT FROM 'shopify_sync_runs'
       OR v_tgt_tbl IS DISTINCT FROM 'shopify_sync_runs'
       OR v_src_schema IS DISTINCT FROM current_schema()
       OR v_tgt_schema IS DISTINCT FROM current_schema()
       OR v_src_cols IS DISTINCT FROM ARRAY['workspace_id', 'parent_sync_run_id']
       OR v_tgt_cols IS DISTINCT FROM ARRAY['workspace_id', 'id'] THEN
      RAISE EXCEPTION '[AIXSHOP Migration 010 Error] Incompatible foreign key "fk_shopify_sync_runs_parent_workspace" already exists (source: %.%(%), target: %.%(%), type: %). Expected shopify_sync_runs(workspace_id, parent_sync_run_id) -> shopify_sync_runs(workspace_id, id).',
        v_src_schema, v_src_tbl, v_src_cols, v_tgt_schema, v_tgt_tbl, v_tgt_cols, v_contype;
    END IF;
  ELSE
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
    WHERE table_schema = current_schema()
      AND table_name = 'shopify_connections'
      AND column_name = 'webhook_last_verified_at'
  ) THEN
    ALTER TABLE shopify_connections ADD COLUMN webhook_last_verified_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'shopify_connections'
      AND column_name = 'webhook_verification_status'
  ) THEN
    ALTER TABLE shopify_connections ADD COLUMN webhook_verification_status VARCHAR(64) NOT NULL DEFAULT 'not_configured';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'shopify_connections'
      AND column_name = 'webhook_verification_details'
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
    WHERE table_schema = current_schema()
      AND table_name = 'workspace_business_profiles'
      AND column_name = 'verification_source'
  ) THEN
    ALTER TABLE workspace_business_profiles ADD COLUMN verification_source VARCHAR(128);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'workspace_business_profiles'
      AND column_name = 'verification_evidence_json'
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
-- Step 4: Non-destructive duplicate check & UNIQUE constraint on ai_visibility_metrics
-- =========================================================================
-- Normalize NULL discovery_topic values to '' first
UPDATE ai_visibility_metrics
SET discovery_topic = ''
WHERE discovery_topic IS NULL;

ALTER TABLE ai_visibility_metrics
  ALTER COLUMN discovery_topic SET DEFAULT '';

ALTER TABLE ai_visibility_metrics
  ALTER COLUMN discovery_topic SET NOT NULL;

DO $$
DECLARE
  v_contype char;
  v_src_tbl text;
  v_src_schema text;
  v_src_cols text[];
  v_is_unique boolean;
  v_has_pred boolean;
  v_dup_groups integer := 0;
BEGIN
  SELECT
    c.contype,
    t.relname,
    n.nspname,
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[]),
    COALESCE(idx.indisunique, false),
    (idx.indpred IS NOT NULL)
  INTO
    v_contype,
    v_src_tbl,
    v_src_schema,
    v_src_cols,
    v_is_unique,
    v_has_pred
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
  LEFT JOIN pg_index idx ON idx.indexrelid = c.conindid
  WHERE c.conname = 'uq_ai_visibility_metric_key'
    AND n.nspname = current_schema();

  IF FOUND THEN
    IF v_contype NOT IN ('u', 'p')
       OR v_src_tbl IS DISTINCT FROM 'ai_visibility_metrics'
       OR v_src_schema IS DISTINCT FROM current_schema()
       OR v_src_cols IS DISTINCT FROM ARRAY['workspace_id', 'observation_date', 'platform', 'discovery_topic']
       OR v_is_unique IS DISTINCT FROM true
       OR v_has_pred IS DISTINCT FROM false THEN
      RAISE EXCEPTION '[AIXSHOP Migration 010 Error] Incompatible constraint "uq_ai_visibility_metric_key" already exists (table: %.%, type: %, columns: %, unique: %, partial: %). Expected non-partial UNIQUE ai_visibility_metrics(workspace_id, observation_date, platform, discovery_topic).',
        v_src_schema, v_src_tbl, v_contype, v_src_cols, v_is_unique, v_has_pred;
    END IF;
  ELSE
    -- Fail loudly instead of destructively summing/deleting historical rows whose provenance cannot distinguish re-imports vs independent observations
    SELECT COUNT(*)
    INTO v_dup_groups
    FROM (
      SELECT 1
      FROM ai_visibility_metrics
      GROUP BY workspace_id, observation_date, platform, discovery_topic
      HAVING COUNT(*) > 1
    ) d;

    IF v_dup_groups > 0 THEN
      RAISE EXCEPTION '[AIXSHOP Migration 010 Error] Ambiguous duplicate rows exist in ai_visibility_metrics (% duplicate key group(s)). Historical Migration 009 rows lack import content hashes to distinguish repeated CSV re-imports from independent observations. Refusing destructive auto-merge/delete. Diagnostic query: SELECT workspace_id, observation_date, platform, discovery_topic, COUNT(*) AS row_count, array_agg(id ORDER BY created_at ASC) AS metric_ids, array_agg(import_id ORDER BY created_at ASC) AS import_ids, SUM(brand_mentions) AS sum_brand, SUM(product_mentions) AS sum_product, SUM(website_clicks) AS sum_clicks FROM ai_visibility_metrics GROUP BY workspace_id, observation_date, platform, discovery_topic HAVING COUNT(*) > 1;',
        v_dup_groups;
    END IF;

    ALTER TABLE ai_visibility_metrics
      ADD CONSTRAINT uq_ai_visibility_metric_key
      UNIQUE (workspace_id, observation_date, platform, discovery_topic);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ai_visibility_imports'
      AND column_name = 'status'
  ) THEN
    ALTER TABLE ai_visibility_imports ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'completed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ai_visibility_imports'
      AND column_name = 'rejected_row_count'
  ) THEN
    ALTER TABLE ai_visibility_imports ADD COLUMN rejected_row_count INTEGER NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ai_visibility_imports'
      AND column_name = 'errors_json'
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
    WHERE table_schema = current_schema()
      AND table_name = 'billing_events'
      AND column_name = 'lease_owner'
  ) THEN
    ALTER TABLE billing_events ADD COLUMN lease_owner VARCHAR(128);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'billing_events'
      AND column_name = 'lease_expires_at'
  ) THEN
    ALTER TABLE billing_events ADD COLUMN lease_expires_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'billing_events'
      AND column_name = 'attempt_count'
  ) THEN
    ALTER TABLE billing_events ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_billing_events_lease
  ON billing_events(status, lease_expires_at);
