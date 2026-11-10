-- AIXSHOP v1.0 — Migration 006: Audit History Snapshots Schema (006_audit_history_snapshots.sql)
-- Immutable snapshots of audit run findings, evidence provenance, product observations,
-- and completion manifest with strict workspace referential integrity and isolation.

-- 1. Audit Run Manifests (tracks explicit snapshot completion, counts, and durability)
CREATE TABLE IF NOT EXISTS audit_run_manifests (
  audit_run_id VARCHAR(64) PRIMARY KEY REFERENCES audit_runs(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL DEFAULT 'COMPLETED',
  products_count INTEGER NOT NULL DEFAULT 0,
  findings_count INTEGER NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_run_manifests_workspace ON audit_run_manifests(workspace_id);

-- 2. Audit Run Findings (immutable snapshot of findings produced during an audit)
CREATE TABLE IF NOT EXISTS audit_run_findings (
  id VARCHAR(128) PRIMARY KEY,
  audit_run_id VARCHAR(64) NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  original_finding_id VARCHAR(64) NOT NULL,
  scope VARCHAR(64) NOT NULL DEFAULT 'product',
  product_id VARCHAR(64) NOT NULL,
  product_title TEXT,
  finding_type VARCHAR(64) NOT NULL,
  severity VARCHAR(32) NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  observed_evidence TEXT,
  derived_conclusion TEXT,
  merchant_verified BOOLEAN NOT NULL DEFAULT FALSE,
  why_it_matters TEXT,
  suggested_correction TEXT,
  target_field VARCHAR(128),
  current_value TEXT,
  recommended_value TEXT,
  action_item_id VARCHAR(64),
  rule_code VARCHAR(64),
  snapshot_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_run_findings_run_ws ON audit_run_findings(audit_run_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_audit_run_findings_product ON audit_run_findings(workspace_id, product_id);

-- 3. Audit Run Evidence (immutable snapshot of evidence documents and their product associations)
CREATE TABLE IF NOT EXISTS audit_run_evidence (
  id VARCHAR(128) PRIMARY KEY,
  audit_run_id VARCHAR(64) NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  original_evidence_id VARCHAR(64) NOT NULL,
  product_id VARCHAR(64),
  title TEXT NOT NULL,
  evidence_type VARCHAR(64) NOT NULL,
  issuer TEXT NOT NULL,
  date_verified TIMESTAMPTZ,
  url TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'unverified',
  source_type VARCHAR(64) NOT NULL DEFAULT 'catalog_evidence',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  snapshot_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_run_evidence_run_ws ON audit_run_evidence(audit_run_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_audit_run_evidence_product ON audit_run_evidence(workspace_id, product_id);

-- 4. Audit Run Products (immutable snapshot of evaluated products and variants)
CREATE TABLE IF NOT EXISTS audit_run_products (
  id VARCHAR(128) PRIMARY KEY,
  audit_run_id VARCHAR(64) NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL,
  title TEXT NOT NULL,
  brand TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  image TEXT,
  completeness_score INTEGER NOT NULL DEFAULT 0,
  attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  variants_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  offers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  findings_count INTEGER NOT NULL DEFAULT 0,
  snapshot_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_run_products_run_ws ON audit_run_products(audit_run_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_audit_run_products_product ON audit_run_products(workspace_id, product_id);
