-- AIXSHOP v1.0 — Migration 012: Production Blocker Remediation (Webhooks, Locks, Visibility History, Auth Rate Limiting, Checksums)
-- Forward-only schema evolution preserving all applied history in Migrations 001–011.
-- Every catalog check strictly qualifies table_schema = current_schema() / nspname = current_schema().

-- =========================================================================
-- Step 1: Migration Checksum Tracking (Workstream H)
-- =========================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'schema_migrations'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'schema_migrations'
        AND column_name = 'checksum'
    ) THEN
      ALTER TABLE schema_migrations ADD COLUMN checksum VARCHAR(64);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'schema_migrations'
        AND column_name = 'checksum_verified_at'
    ) THEN
      ALTER TABLE schema_migrations ADD COLUMN checksum_verified_at TIMESTAMPTZ;
    END IF;
  END IF;
END $$;

-- =========================================================================
-- Step 2: Shopify Webhook Worker Leases & Retry Metadata (Workstream A)
-- =========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'shopify_webhook_events'
      AND column_name = 'lease_owner'
  ) THEN
    ALTER TABLE shopify_webhook_events ADD COLUMN lease_owner VARCHAR(128);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'shopify_webhook_events'
      AND column_name = 'lease_expires_at'
  ) THEN
    ALTER TABLE shopify_webhook_events ADD COLUMN lease_expires_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'shopify_webhook_events'
      AND column_name = 'attempt_count'
  ) THEN
    ALTER TABLE shopify_webhook_events ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shopify_webhook_events_lease
  ON shopify_webhook_events(status, lease_expires_at);

-- =========================================================================
-- Step 3: Store Catalog Version Guard (Workstream B)
-- =========================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'stores'
      AND column_name = 'catalog_version'
  ) THEN
    ALTER TABLE stores ADD COLUMN catalog_version INTEGER NOT NULL DEFAULT 1;
  END IF;
END $$;

-- =========================================================================
-- Step 4: Shared Database-Backed Auth Rate Limiting (Workstream G)
-- =========================================================================
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  rate_key VARCHAR(255) PRIMARY KEY,
  attempt_count INTEGER NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_reset
  ON auth_rate_limits(reset_at);

-- =========================================================================
-- Step 5: Visibility Deduplication Index, NULL vs '' Provenance & History (Workstreams D & E)
-- =========================================================================
DO $$
DECLARE
  v_dup_import_groups INTEGER := 0;
  v_has_import_uq BOOLEAN := false;
BEGIN
  -- Refuse silent deletion if historical duplicate completed imports already exist for same (workspace_id, content_hash)
  SELECT COUNT(*)
  INTO v_dup_import_groups
  FROM (
    SELECT 1
    FROM ai_visibility_imports
    WHERE content_hash IS NOT NULL
      AND status = 'completed'
    GROUP BY workspace_id, content_hash
    HAVING COUNT(*) > 1
  ) dup;

  IF v_dup_import_groups > 0 THEN
    RAISE EXCEPTION '[AIXSHOP Migration 012 Error] Duplicate completed ai_visibility_imports rows exist for (% group(s)) on (workspace_id, content_hash); refusing silent deletion.',
      v_dup_import_groups;
  END IF;

  -- Ensure unique key on ai_visibility_imports(workspace_id, id) for tenant-safe foreign key references
  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = current_schema()
      AND t.relname = 'ai_visibility_imports'
      AND c.conname = 'uq_ai_visibility_imports_workspace_id'
  ) INTO v_has_import_uq;

  IF NOT v_has_import_uq THEN
    ALTER TABLE ai_visibility_imports
      ADD CONSTRAINT uq_ai_visibility_imports_workspace_id UNIQUE (workspace_id, id);
  END IF;

  -- Preserve NULL vs empty-string distinction without altering legacy pre-012 '' semantics
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ai_visibility_metrics'
      AND column_name = 'topic_presence'
  ) THEN
    ALTER TABLE ai_visibility_metrics
      ADD COLUMN topic_presence VARCHAR(32) NOT NULL DEFAULT 'legacy_ambiguous';

    UPDATE ai_visibility_metrics
    SET topic_presence = 'specified'
    WHERE discovery_topic IS NOT NULL
      AND discovery_topic <> ''
      AND topic_presence = 'legacy_ambiguous';
  END IF;

  -- Allow future records to store genuine NULL (unspecified) distinct from '' (explicit_blank)
  -- without retroactively guessing pre-012 '' rows that Migration 010/011 coerced.
  ALTER TABLE ai_visibility_metrics
    ALTER COLUMN discovery_topic DROP NOT NULL;

  ALTER TABLE ai_visibility_metrics
    ALTER COLUMN discovery_topic DROP DEFAULT;
END $$;

-- Unique index enforcing atomic CSV import deduplication across concurrent workers
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_visibility_imports_ws_hash
  ON ai_visibility_imports(workspace_id, content_hash)
  WHERE content_hash IS NOT NULL AND status = 'completed';

-- Unique partial index enforcing uniqueness when discovery_topic IS NULL (unspecified)
-- without conflating it with '' (explicit_blank)
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_visibility_metric_null_topic
  ON ai_visibility_metrics(workspace_id, observation_date, platform)
  WHERE discovery_topic IS NULL;

-- Immutable observation provenance & replacement audit ledger
CREATE TABLE IF NOT EXISTS ai_visibility_observation_history (
  id VARCHAR(128) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  import_id VARCHAR(64) NOT NULL,
  observation_date DATE NOT NULL,
  platform VARCHAR(64) NOT NULL,
  discovery_topic VARCHAR(255),
  topic_presence VARCHAR(32) NOT NULL,
  brand_mentions INTEGER NOT NULL DEFAULT 0,
  product_mentions INTEGER NOT NULL DEFAULT 0,
  website_clicks INTEGER NOT NULL DEFAULT 0,
  evidence_source VARCHAR(255),
  event_type VARCHAR(32) NOT NULL DEFAULT 'recorded',
  version_number INTEGER NOT NULL DEFAULT 1,
  supersedes_history_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_visibility_history_import_ws
    FOREIGN KEY (workspace_id, import_id)
    REFERENCES ai_visibility_imports(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_visibility_obs_history_lookup
  ON ai_visibility_observation_history(workspace_id, observation_date, platform, discovery_topic);
