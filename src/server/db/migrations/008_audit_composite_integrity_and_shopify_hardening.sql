-- AIXSHOP v1.0 — Migration 008: Composite Integrity & Shopify Hardening (008_audit_composite_integrity_and_shopify_hardening.sql)
-- 1. Enforces strict composite referential integrity between workspaces, audit_runs, and snapshot tables.
-- 2. Adds token refresh expiration, last refreshed timestamp, and registered webhook subscriptions to shopify_connections.

-- Step 1: Add UNIQUE constraint on audit_runs(workspace_id, id) to serve as composite foreign key target
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'uq_audit_runs_workspace_id'
      AND conrelid = 'audit_runs'::regclass
  ) THEN
    ALTER TABLE audit_runs ADD CONSTRAINT uq_audit_runs_workspace_id UNIQUE (workspace_id, id);
  END IF;
END $$;

-- Step 2: Ensure no orphaned snapshot rows violate composite integrity before attaching FKs
DO $$
BEGIN
  -- Verify audit_run_manifests
  IF EXISTS (
    SELECT 1 FROM audit_run_manifests m
    LEFT JOIN audit_runs a ON a.workspace_id = m.workspace_id AND a.id = m.audit_run_id
    WHERE a.id IS NULL
  ) THEN
    RAISE EXCEPTION '[AIXSHOP Migration 008 Error] Inconsistent records detected in audit_run_manifests: foreign key target not found in audit_runs.';
  END IF;

  -- Verify audit_run_findings
  IF EXISTS (
    SELECT 1 FROM audit_run_findings f
    LEFT JOIN audit_runs a ON a.workspace_id = f.workspace_id AND a.id = f.audit_run_id
    WHERE a.id IS NULL
  ) THEN
    RAISE EXCEPTION '[AIXSHOP Migration 008 Error] Inconsistent records detected in audit_run_findings: foreign key target not found in audit_runs.';
  END IF;

  -- Verify audit_run_evidence
  IF EXISTS (
    SELECT 1 FROM audit_run_evidence e
    LEFT JOIN audit_runs a ON a.workspace_id = e.workspace_id AND a.id = e.audit_run_id
    WHERE a.id IS NULL
  ) THEN
    RAISE EXCEPTION '[AIXSHOP Migration 008 Error] Inconsistent records detected in audit_run_evidence: foreign key target not found in audit_runs.';
  END IF;

  -- Verify audit_run_products
  IF EXISTS (
    SELECT 1 FROM audit_run_products p
    LEFT JOIN audit_runs a ON a.workspace_id = p.workspace_id AND a.id = p.audit_run_id
    WHERE a.id IS NULL
  ) THEN
    RAISE EXCEPTION '[AIXSHOP Migration 008 Error] Inconsistent records detected in audit_run_products: foreign key target not found in audit_runs.';
  END IF;
END $$;

-- Step 3: Upgrade foreign keys on snapshot tables to composite (workspace_id, audit_run_id)
DO $$
BEGIN
  -- 3.1 audit_run_manifests
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'fk_manifests_run_workspace'
      AND conrelid = 'audit_run_manifests'::regclass
  ) THEN
    ALTER TABLE audit_run_manifests 
      ADD CONSTRAINT fk_manifests_run_workspace 
      FOREIGN KEY (workspace_id, audit_run_id) 
      REFERENCES audit_runs(workspace_id, id) 
      ON DELETE CASCADE;
  END IF;

  -- 3.2 audit_run_findings
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'fk_findings_run_workspace'
      AND conrelid = 'audit_run_findings'::regclass
  ) THEN
    ALTER TABLE audit_run_findings 
      ADD CONSTRAINT fk_findings_run_workspace 
      FOREIGN KEY (workspace_id, audit_run_id) 
      REFERENCES audit_runs(workspace_id, id) 
      ON DELETE CASCADE;
  END IF;

  -- 3.3 audit_run_evidence
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'fk_evidence_run_workspace'
      AND conrelid = 'audit_run_evidence'::regclass
  ) THEN
    ALTER TABLE audit_run_evidence 
      ADD CONSTRAINT fk_evidence_run_workspace 
      FOREIGN KEY (workspace_id, audit_run_id) 
      REFERENCES audit_runs(workspace_id, id) 
      ON DELETE CASCADE;
  END IF;

  -- 3.4 audit_run_products
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'fk_products_run_workspace'
      AND conrelid = 'audit_run_products'::regclass
  ) THEN
    ALTER TABLE audit_run_products 
      ADD CONSTRAINT fk_products_run_workspace 
      FOREIGN KEY (workspace_id, audit_run_id) 
      REFERENCES audit_runs(workspace_id, id) 
      ON DELETE CASCADE;
  END IF;
END $$;

-- Step 4: Add Shopify token refresh & webhook subscription columns to shopify_connections
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shopify_connections' AND column_name = 'refresh_token_expires_at'
  ) THEN
    ALTER TABLE shopify_connections ADD COLUMN refresh_token_expires_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shopify_connections' AND column_name = 'last_refreshed_at'
  ) THEN
    ALTER TABLE shopify_connections ADD COLUMN last_refreshed_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'shopify_connections' AND column_name = 'webhook_subscriptions_json'
  ) THEN
    ALTER TABLE shopify_connections ADD COLUMN webhook_subscriptions_json JSONB NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END $$;
