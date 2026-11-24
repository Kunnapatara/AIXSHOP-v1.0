-- AIXSHOP v1.0 — Migration 018: Secure, Idempotent & Recoverable Guest-to-Cloud Catalog Transfers
-- Forward-only schema evolution preserving all applied history in Migrations 001–017.

CREATE TABLE IF NOT EXISTS guest_transfer_authorizations (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(128) UNIQUE NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  payload_sha256 VARCHAR(128) NOT NULL,
  conflict_strategy VARCHAR(32) NOT NULL DEFAULT 'abort_on_conflict',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ,
  result_summary_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_guest_transfer_auth_ws_user_status
  ON guest_transfer_authorizations(workspace_id, user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS guest_transfer_audit_log (
  id VARCHAR(64) PRIMARY KEY,
  transfer_id VARCHAR(64) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outcome VARCHAR(32) NOT NULL,
  conflict_strategy VARCHAR(32) NOT NULL,
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  conflicts_count INTEGER NOT NULL DEFAULT 0,
  catalog_version_before INTEGER,
  catalog_version_after INTEGER,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guest_transfer_audit_ws_created
  ON guest_transfer_audit_log(workspace_id, created_at DESC);
