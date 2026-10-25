-- AIXSHOP v1.0 — Initial Multi-Tenant Schema Migration (001_initial_schema.sql)
-- Enforces strict multi-tenant workspace isolation, row-level foreign keys,
-- two-decimal monetary precision, and session management.

-- 1. Users
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 2. Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Workspace Memberships (RBAC & Multi-tenant boundary)
CREATE TABLE IF NOT EXISTS workspace_memberships (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL DEFAULT 'member', -- 'owner', 'admin', 'member'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_workspace_user UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON workspace_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_workspace ON workspace_memberships(workspace_id);

-- 4. Server-Managed Sessions (Hashed token for defense-in-depth)
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(64) PRIMARY KEY,
  session_token_hash VARCHAR(128) UNIQUE NOT NULL,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address VARCHAR(64),
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(session_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- 5. Stores owned by Workspaces
CREATE TABLE IF NOT EXISTS stores (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  domain VARCHAR(255) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  sku_count INTEGER NOT NULL DEFAULT 0,
  catalog_completeness_avg INTEGER NOT NULL DEFAULT 0,
  truth_boundary_strictness VARCHAR(32) NOT NULL DEFAULT 'balanced',
  tier VARCHAR(32) NOT NULL DEFAULT 'Free Audit',
  sku_limit INTEGER,
  connectors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stores_workspace ON stores(workspace_id);

-- 6. Catalog Products (Scoped to workspace_id)
CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(64) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id VARCHAR(64) NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  brand VARCHAR(255) NOT NULL,
  category VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  image TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  completeness_score INTEGER NOT NULL DEFAULT 0,
  evidence_coverage_score INTEGER NOT NULL DEFAULT 0,
  external_discovery_status VARCHAR(64) NOT NULL DEFAULT 'unindexed',
  attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  findings_count INTEGER NOT NULL DEFAULT 0,
  last_audited VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_products_workspace ON products(workspace_id);

-- 7. Product Variants (Scoped to workspace_id and product_id)
CREATE TABLE IF NOT EXISTS variants (
  id VARCHAR(64) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL,
  sku VARCHAR(255) NOT NULL,
  title TEXT NOT NULL,
  barcode VARCHAR(64) NOT NULL DEFAULT '',
  price NUMERIC(14, 2), -- Strict 2-decimal monetary precision
  inventory_count INTEGER,
  attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT fk_variant_product FOREIGN KEY (workspace_id, product_id)
    REFERENCES products (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(workspace_id, product_id);

-- 8. Offers (Scoped to workspace_id and product_id)
CREATE TABLE IF NOT EXISTS offers (
  id VARCHAR(64) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL,
  channel VARCHAR(64) NOT NULL,
  price NUMERIC(14, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  availability VARCHAR(32) NOT NULL DEFAULT 'in_stock',
  condition VARCHAR(32) NOT NULL DEFAULT 'new',
  url TEXT NOT NULL DEFAULT '',
  merchant_id VARCHAR(64) NOT NULL DEFAULT '',
  last_sync VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT fk_offer_product FOREIGN KEY (workspace_id, product_id)
    REFERENCES products (workspace_id, id) ON DELETE CASCADE
);

-- 9. Evidence Documents (Scoped to workspace_id and product_id)
CREATE TABLE IF NOT EXISTS evidence_documents (
  id VARCHAR(64) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL,
  title TEXT NOT NULL,
  type VARCHAR(64) NOT NULL,
  issuer VARCHAR(255) NOT NULL,
  date_verified VARCHAR(64) NOT NULL,
  url TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'verified',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT fk_evidence_product FOREIGN KEY (workspace_id, product_id)
    REFERENCES products (workspace_id, id) ON DELETE CASCADE
);

-- 10. Audit Findings (Scoped to workspace_id and store_id)
CREATE TABLE IF NOT EXISTS findings (
  id VARCHAR(64) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id VARCHAR(64) NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id VARCHAR(64),
  scope VARCHAR(32) NOT NULL,
  type VARCHAR(64) NOT NULL,
  severity VARCHAR(32) NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  observed_evidence TEXT NOT NULL,
  derived_conclusion TEXT NOT NULL,
  merchant_verified BOOLEAN NOT NULL DEFAULT FALSE,
  why_it_matters TEXT NOT NULL,
  suggested_correction TEXT,
  target_field VARCHAR(255),
  current_value TEXT,
  recommended_value TEXT,
  action_item_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_findings_workspace ON findings(workspace_id);

-- 11. Action Items (Scoped to workspace_id and store_id)
CREATE TABLE IF NOT EXISTS action_items (
  id VARCHAR(64) NOT NULL,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  store_id VARCHAR(64) NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  finding_id VARCHAR(64) NOT NULL,
  product_id VARCHAR(64),
  title TEXT NOT NULL,
  severity VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending_review',
  verification_status VARCHAR(64) NOT NULL DEFAULT 'unverified',
  proposed_change_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  audit_log_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_actions_workspace ON action_items(workspace_id);
