-- AIXSHOP v1.0 — Migration 007: Shopify Integration Schema (007_shopify_integration.sql)
-- Real multi-tenant Shopify Admin GraphQL connection management, encrypted credentials,
-- paginated sync tracking, and idempotent webhook event auditing.

-- 1. Shopify Connections (secure, workspace-isolated connection records)
CREATE TABLE IF NOT EXISTS shopify_connections (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shop_domain VARCHAR(255) NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  granted_scopes TEXT NOT NULL DEFAULT 'read_products',
  key_version VARCHAR(32) NOT NULL DEFAULT 'v1',
  status VARCHAR(32) NOT NULL DEFAULT 'connected',
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_workspace_shopify_conn UNIQUE (workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_shopify_connections_workspace ON shopify_connections(workspace_id);
CREATE INDEX IF NOT EXISTS idx_shopify_connections_shop ON shopify_connections(shop_domain);

-- 2. Shopify Sync Runs (durable tracking of GraphQL cursor pagination & SKU entitlement limits)
CREATE TABLE IF NOT EXISTS shopify_sync_runs (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shop_domain VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  products_discovered INTEGER NOT NULL DEFAULT 0,
  products_imported INTEGER NOT NULL DEFAULT 0,
  variants_imported INTEGER NOT NULL DEFAULT 0,
  excluded_by_plan INTEGER NOT NULL DEFAULT 0,
  cursor_resumed VARCHAR(255),
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shopify_sync_runs_workspace ON shopify_sync_runs(workspace_id, created_at DESC);

-- 3. Shopify Webhook Events (idempotent delivery tracking with raw payload preservation)
CREATE TABLE IF NOT EXISTS shopify_webhook_events (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shop_domain VARCHAR(255) NOT NULL,
  event_id VARCHAR(128) NOT NULL,
  topic VARCHAR(128) NOT NULL,
  delivery_id VARCHAR(128),
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'processing',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_shopify_webhook_event UNIQUE (shop_domain, topic, event_id)
);

CREATE INDEX IF NOT EXISTS idx_shopify_webhook_events_workspace ON shopify_webhook_events(workspace_id);
CREATE INDEX IF NOT EXISTS idx_shopify_webhook_events_delivery ON shopify_webhook_events(delivery_id);
CREATE INDEX IF NOT EXISTS idx_shopify_webhook_events_status ON shopify_webhook_events(status);

-- 4. Shopify OAuth States (cryptographic nonce tracking to prevent CSRF)
CREATE TABLE IF NOT EXISTS shopify_oauth_states (
  id VARCHAR(128) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shop_domain VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shopify_oauth_states_expires ON shopify_oauth_states(expires_at);
