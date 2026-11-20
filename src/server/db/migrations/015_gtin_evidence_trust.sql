-- AIXSHOP v1.0 — Migration 015: Server-Owned GTIN Evidence Verification & Shopify Provenance
-- Forward-only schema evolution preserving all applied history in Migrations 001–014.

-- 1. Change evidence_documents default status from legacy 'verified' to 'pending'
ALTER TABLE evidence_documents
  ALTER COLUMN status SET DEFAULT 'pending';

-- 2. Add server-controlled verification provenance & integrity columns to evidence_documents
ALTER TABLE evidence_documents
  ADD COLUMN IF NOT EXISTS evidence_purpose VARCHAR(64) NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS verification_source VARCHAR(64) NOT NULL DEFAULT 'client_submission',
  ADD COLUMN IF NOT EXISTS submitted_by_user_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(128),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision VARCHAR(32) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS decision_reason TEXT,
  ADD COLUMN IF NOT EXISTS integrity_hash VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_evidence_documents_workspace_product_status
  ON evidence_documents(workspace_id, product_id, status);

-- 3. Immutable append-only evidence review audit trail (workspace-scoped)
CREATE TABLE IF NOT EXISTS evidence_review_audit_log (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  evidence_id VARCHAR(64) NOT NULL,
  product_id VARCHAR(64) NOT NULL,
  action VARCHAR(32) NOT NULL,
  decision VARCHAR(32) NOT NULL,
  reviewer_id VARCHAR(128),
  reviewer_role VARCHAR(64),
  reason TEXT,
  integrity_hash VARCHAR(128) NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_review_audit_workspace_evidence
  ON evidence_review_audit_log(workspace_id, evidence_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_evidence_review_audit_workspace_created
  ON evidence_review_audit_log(workspace_id, created_at DESC);

-- 4. Server-owned Shopify product provenance (protected from client catalog writes)
CREATE TABLE IF NOT EXISTS shopify_product_provenance (
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL,
  shop_domain VARCHAR(255) NOT NULL,
  shopify_product_id VARCHAR(64) NOT NULL,
  shopify_gid VARCHAR(255) NOT NULL,
  is_gift_card BOOLEAN NOT NULL DEFAULT FALSE,
  source_type VARCHAR(64) NOT NULL,
  shopify_updated_at VARCHAR(64),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_shopify_product_provenance_shop
  ON shopify_product_provenance(workspace_id, shop_domain, is_gift_card);
