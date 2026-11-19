-- AIXSHOP v1.0 — Migration 014: Auth Password Recovery Tokens & Workspace Operation Leases
-- Forward-only schema evolution preserving all applied history in Migrations 001–013.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(128) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  requested_ip VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_expires
  ON password_reset_tokens(user_id, expires_at);

CREATE TABLE IF NOT EXISTS workspace_operation_leases (
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_key VARCHAR(64) NOT NULL,
  lease_owner VARCHAR(128) NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, operation_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_operation_leases_expires
  ON workspace_operation_leases(lease_expires_at);
