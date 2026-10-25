-- AIXSHOP v1.0 — Migration 003: Store SKU Entitlement Persistence (003_store_sku_limit.sql)
-- Adds nullable sku_limit to stores table to allow durable persistence of custom plan limits.
-- When NULL, authoritative tier defaults apply (Starter: 250, Growth: 2500, Enterprise: Unlimited, Free Audit: 2500).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'stores' AND column_name = 'sku_limit'
  ) THEN
    ALTER TABLE stores ADD COLUMN sku_limit INTEGER;
  END IF;
END $$;
