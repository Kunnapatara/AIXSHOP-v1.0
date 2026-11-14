-- AIXSHOP v1.0 — Migration 011: Corrective Integrity, Multi-Schema Repair & Visibility Content Provenance (011_corrective_integrity_and_visibility_provenance.sql)
-- Schema Contract:
--   Executed inside the active PostgreSQL target schema resolved via current_schema().
--   In multi-schema deployments (e.g. staging/tenant_a/public in one cluster), search_path MUST place the
--   target application schema first. Every catalog lookup filters by table_schema = current_schema() or
--   nspname = current_schema() so columns/constraints in sibling schemas never mask missing objects here.
-- Purpose:
--   1. Forward-only repair for databases where legacy Migration 010 skipped columns due to unqualified
--      information_schema.columns lookups across sibling schemas.
--   2. Strict definition verification of uq_shopify_sync_runs_workspace_id, fk_shopify_sync_runs_parent_workspace,
--      and uq_ai_visibility_metric_key (non-partial unique constraint with exact ordered columns).
--   3. Adds content_hash SHA-256 provenance column + partial index to ai_visibility_imports so repeated
--      identical CSV uploads are idempotently skipped without double-counting.

-- =========================================================================
-- Step 1: Schema-qualified repair of Migration 010 columns in current_schema()
-- =========================================================================
DO $$
BEGIN
  -- shopify_connections verification columns
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

  -- workspace_business_profiles provenance columns
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

  -- ai_visibility_imports status & provenance columns
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

  -- New in 011: SHA-256 fingerprint of canonicalized CSV payload for idempotent repeat-upload detection
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ai_visibility_imports'
      AND column_name = 'content_hash'
  ) THEN
    ALTER TABLE ai_visibility_imports ADD COLUMN content_hash VARCHAR(64);
  END IF;

  -- billing_events durable worker lease columns
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

CREATE INDEX IF NOT EXISTS idx_ai_visibility_imports_ws_hash
  ON ai_visibility_imports(workspace_id, content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_events_lease
  ON billing_events(status, lease_expires_at);

-- =========================================================================
-- Step 2: Strict definition verification for Migration 010 unique & FK constraints
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
  v_dup_groups integer := 0;
BEGIN
  -- 2a. uq_shopify_sync_runs_workspace_id
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
      RAISE EXCEPTION '[AIXSHOP Migration 011 Error] Incompatible constraint "uq_shopify_sync_runs_workspace_id" already exists (table: %.%, type: %, columns: %, unique: %, partial: %). Manual review required before remediation.',
        v_src_schema, v_src_tbl, v_contype, v_src_cols, v_is_unique, v_has_pred;
    END IF;
  ELSE
    ALTER TABLE shopify_sync_runs
      ADD CONSTRAINT uq_shopify_sync_runs_workspace_id UNIQUE (workspace_id, id);
  END IF;

  -- 2b. fk_shopify_sync_runs_parent_workspace
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
      RAISE EXCEPTION '[AIXSHOP Migration 011 Error] Incompatible foreign key "fk_shopify_sync_runs_parent_workspace" already exists (source: %.%(%), target: %.%(%), type: %). Manual review required.',
        v_src_schema, v_src_tbl, v_src_cols, v_tgt_schema, v_tgt_tbl, v_tgt_cols, v_contype;
    END IF;
  ELSE
    ALTER TABLE shopify_sync_runs
      ADD CONSTRAINT fk_shopify_sync_runs_parent_workspace
      FOREIGN KEY (workspace_id, parent_sync_run_id)
      REFERENCES shopify_sync_runs(workspace_id, id);
  END IF;

  -- 2c. uq_ai_visibility_metric_key (normalize NULL discovery_topic safely first)
  UPDATE ai_visibility_metrics
  SET discovery_topic = ''
  WHERE discovery_topic IS NULL;

  ALTER TABLE ai_visibility_metrics
    ALTER COLUMN discovery_topic SET DEFAULT '';

  ALTER TABLE ai_visibility_metrics
    ALTER COLUMN discovery_topic SET NOT NULL;

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
      RAISE EXCEPTION '[AIXSHOP Migration 011 Error] Incompatible constraint "uq_ai_visibility_metric_key" already exists (table: %.%, type: %, columns: %, unique: %, partial: %). Manual review required.',
        v_src_schema, v_src_tbl, v_contype, v_src_cols, v_is_unique, v_has_pred;
    END IF;
  ELSE
    SELECT COUNT(*)
    INTO v_dup_groups
    FROM (
      SELECT 1
      FROM ai_visibility_metrics
      GROUP BY workspace_id, observation_date, platform, discovery_topic
      HAVING COUNT(*) > 1
    ) d;

    IF v_dup_groups > 0 THEN
      RAISE EXCEPTION '[AIXSHOP Migration 011 Error] Ambiguous duplicate rows exist in ai_visibility_metrics (% group(s)); refusing destructive auto-merge/delete.',
        v_dup_groups;
    END IF;

    ALTER TABLE ai_visibility_metrics
      ADD CONSTRAINT uq_ai_visibility_metric_key
      UNIQUE (workspace_id, observation_date, platform, discovery_topic);
  END IF;
END $$;
