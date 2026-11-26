-- AIXSHOP v1.0 — Migration 019: Shopify Approved Write-Back Audit Trail & Billing Email Delivery Ledger
-- Forward-only schema evolution preserving all applied history in Migrations 001–018.

-- 1. Durable, idempotent Shopify write-back operations table
CREATE TABLE IF NOT EXISTS shopify_writeback_operations (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_id VARCHAR(128) NOT NULL,
  product_id VARCHAR(128) NOT NULL,
  shop_domain VARCHAR(255) NOT NULL,
  shopify_product_gid VARCHAR(128) NOT NULL,
  shopify_variant_gid VARCHAR(128),
  field_path VARCHAR(255) NOT NULL,
  before_value TEXT,
  approved_value TEXT NOT NULL,
  verified_value TEXT,
  status VARCHAR(48) NOT NULL DEFAULT 'pending',
  idempotency_key VARCHAR(255) NOT NULL,
  shopify_mutation_id VARCHAR(128),
  operator_user_id VARCHAR(64) NOT NULL,
  error_code VARCHAR(64),
  error_message TEXT,
  audit_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  CONSTRAINT uq_shopify_writeback_ws_idemp UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_shopify_writeback_ws_action
  ON shopify_writeback_operations(workspace_id, action_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_writeback_ws_status
  ON shopify_writeback_operations(workspace_id, status, created_at DESC);

-- 2. Durable, idempotent billing lifecycle email delivery ledger
CREATE TABLE IF NOT EXISTS billing_email_deliveries (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delivery_key VARCHAR(255) UNIQUE NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  recipient_email VARCHAR(255) NOT NULL,
  tier VARCHAR(64),
  amount_cents INTEGER,
  currency VARCHAR(16),
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  smtp_message_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  inbox_delivery_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  message_id VARCHAR(255),
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  next_retry_at TIMESTAMPTZ,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_billing_email_deliveries_ws_created
  ON billing_email_deliveries(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_email_deliveries_retry
  ON billing_email_deliveries(status, next_retry_at);
