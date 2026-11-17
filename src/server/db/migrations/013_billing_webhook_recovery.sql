-- AIXSHOP v1.0 — Migration 013: Durable Billing Webhook Recovery & Retry Metadata (013_billing_webhook_recovery.sql)
-- Forward-only schema evolution preserving all applied history in Migrations 001–012.
-- Adds explicit failure diagnostics, retry attempt timestamps, backoff scheduling,
-- and a partial recovery index on billing_events without altering existing event payloads.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'billing_events'
      AND column_name = 'last_error'
  ) THEN
    ALTER TABLE billing_events ADD COLUMN last_error TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'billing_events'
      AND column_name = 'last_attempt_at'
  ) THEN
    ALTER TABLE billing_events ADD COLUMN last_attempt_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'billing_events'
      AND column_name = 'next_retry_at'
  ) THEN
    ALTER TABLE billing_events ADD COLUMN next_retry_at TIMESTAMPTZ;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_billing_events_recovery
  ON billing_events(status, lease_expires_at, next_retry_at)
  WHERE status IN ('processing', 'failed');
