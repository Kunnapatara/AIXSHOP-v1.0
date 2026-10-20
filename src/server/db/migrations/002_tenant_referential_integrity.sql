-- AIXSHOP v1.0 — Tenant Referential Integrity Hardening (002_tenant_referential_integrity.sql)
-- Enforces composite foreign keys for stores, products, findings, and action items
-- to prevent cross-workspace references at the RDBMS constraint level.
-- Idempotent and non-destructive.

DO $$
BEGIN
  -- 1. Candidate key on stores(workspace_id, id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_stores_workspace_id'
  ) THEN
    ALTER TABLE stores ADD CONSTRAINT uq_stores_workspace_id UNIQUE (workspace_id, id);
  END IF;

  -- 2. Composite FK: products(workspace_id, store_id) -> stores(workspace_id, id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_products_store_workspace'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT fk_products_store_workspace
      FOREIGN KEY (workspace_id, store_id)
      REFERENCES stores (workspace_id, id) ON DELETE CASCADE;
  END IF;

  -- 3. Composite FK: findings(workspace_id, store_id) -> stores(workspace_id, id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_findings_store_workspace'
  ) THEN
    ALTER TABLE findings ADD CONSTRAINT fk_findings_store_workspace
      FOREIGN KEY (workspace_id, store_id)
      REFERENCES stores (workspace_id, id) ON DELETE CASCADE;
  END IF;

  -- 4. Composite FK: findings(workspace_id, product_id) -> products(workspace_id, id)
  -- (NULL product_id allowed for store-scoped findings via MATCH SIMPLE)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_findings_product_workspace'
  ) THEN
    ALTER TABLE findings ADD CONSTRAINT fk_findings_product_workspace
      FOREIGN KEY (workspace_id, product_id)
      REFERENCES products (workspace_id, id) ON DELETE CASCADE;
  END IF;

  -- 5. Composite FK: action_items(workspace_id, store_id) -> stores(workspace_id, id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_action_items_store_workspace'
  ) THEN
    ALTER TABLE action_items ADD CONSTRAINT fk_action_items_store_workspace
      FOREIGN KEY (workspace_id, store_id)
      REFERENCES stores (workspace_id, id) ON DELETE CASCADE;
  END IF;

  -- 6. Composite FK: action_items(workspace_id, finding_id) -> findings(workspace_id, id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_action_items_finding_workspace'
  ) THEN
    ALTER TABLE action_items ADD CONSTRAINT fk_action_items_finding_workspace
      FOREIGN KEY (workspace_id, finding_id)
      REFERENCES findings (workspace_id, id) ON DELETE CASCADE;
  END IF;

  -- 7. Composite FK: action_items(workspace_id, product_id) -> products(workspace_id, id)
  -- (NULL product_id allowed for store-scoped actions via MATCH SIMPLE)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_action_items_product_workspace'
  ) THEN
    ALTER TABLE action_items ADD CONSTRAINT fk_action_items_product_workspace
      FOREIGN KEY (workspace_id, product_id)
      REFERENCES products (workspace_id, id) ON DELETE CASCADE;
  END IF;
END $$;
