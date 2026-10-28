-- AIXSHOP v1.0 — Migration 005: Billing & Subscriptions Schema (005_billing_subscriptions.sql)
-- Manages multi-tenant subscription state, provider customer mappings,
-- and atomic webhook event claims with strict workspace referential integrity.

CREATE TABLE IF NOT EXISTS subscriptions (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider VARCHAR(64) NOT NULL DEFAULT 'stripe',
  customer_id VARCHAR(128) NOT NULL,
  subscription_id VARCHAR(128) NOT NULL,
  tier VARCHAR(32) NOT NULL DEFAULT 'Starter',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  last_event_created BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_workspace_subscription UNIQUE (workspace_id)
);

-- Ensure forward compatibility if table previously existed without last_event_created
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_event_created BIGINT DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_subscriptions_workspace ON subscriptions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_sub_id ON subscriptions(subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);

CREATE TABLE IF NOT EXISTS billing_events (
  id VARCHAR(64) PRIMARY KEY,
  provider VARCHAR(64) NOT NULL,
  event_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'processing',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_billing_events_provider_event UNIQUE (provider, event_id)
);

-- Ensure forward compatibility if table previously existed
ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_billing_events_event_id ON billing_events(event_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_idempotency ON billing_events(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_billing_events_status ON billing_events(status);
