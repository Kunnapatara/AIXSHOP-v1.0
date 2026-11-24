-- AIXSHOP v1.0 — Migration 017: Server-Authoritative Reviewer Identity & External Registry Trust
-- Forward-only schema evolution preserving all applied history in Migrations 001–016.

-- 1. Platform reviewer authorization columns on users (strictly server-controlled)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS platform_role VARCHAR(32) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS platform_reviewer_scopes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS platform_reviewer_revoked_at TIMESTAMPTZ;

-- 2. Server-managed reviewer service principals (supports key rotation & revocation)
CREATE TABLE IF NOT EXISTS reviewer_service_principals (
  id VARCHAR(64) PRIMARY KEY,
  principal_id VARCHAR(128) UNIQUE NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  secret_hash VARCHAR(128) NOT NULL,
  key_id VARCHAR(64) NOT NULL,
  scopes_json JSONB NOT NULL DEFAULT '["evidence:review"]'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviewer_service_principals_status
  ON reviewer_service_principals(status, key_id);

-- 3. Explicit reviewer principal provenance & external registry trust separation on evidence_documents
ALTER TABLE evidence_documents
  ADD COLUMN IF NOT EXISTS reviewer_principal_type VARCHAR(64),
  ADD COLUMN IF NOT EXISTS reviewer_auth_method VARCHAR(64),
  ADD COLUMN IF NOT EXISTS external_verification_status VARCHAR(64) NOT NULL DEFAULT 'not_externally_verified',
  ADD COLUMN IF NOT EXISTS external_provider_name VARCHAR(128),
  ADD COLUMN IF NOT EXISTS external_provider_ref VARCHAR(255),
  ADD COLUMN IF NOT EXISTS external_request_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_response_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_verification_result VARCHAR(64),
  ADD COLUMN IF NOT EXISTS external_verification_evidence_json JSONB;

CREATE INDEX IF NOT EXISTS idx_evidence_documents_external_status
  ON evidence_documents(workspace_id, external_verification_status);

-- 4. Conservative backfill of pre-017 historical review rows:
--    - Approved server-reviewed rows become 'reviewer_verified' (NOT 'external_registry_verified').
--    - Any legacy row claiming verification_source = 'external_registry' without real provider metadata
--      is conservatively downgraded to 'server_reviewer' / 'reviewer_verified'.
UPDATE evidence_documents
SET
  external_verification_status = CASE
    WHEN status = 'verified' AND decision = 'approved' AND reviewed_by IS NOT NULL
      AND verification_source IN ('server_reviewer', 'external_registry')
      THEN 'reviewer_verified'
    ELSE 'not_externally_verified'
  END,
  verification_source = CASE
    WHEN verification_source = 'external_registry' AND external_provider_name IS NULL
      THEN 'server_reviewer'
    ELSE verification_source
  END
WHERE external_verification_status = 'not_externally_verified';

-- 5. Attribution provenance on evidence_review_audit_log
ALTER TABLE evidence_review_audit_log
  ADD COLUMN IF NOT EXISTS principal_type VARCHAR(64),
  ADD COLUMN IF NOT EXISTS auth_method VARCHAR(64);
