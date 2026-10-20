-- AIXSHOP v1.0 — Tenant Referential Integrity Hardening (002_tenant_referential_integrity.sql)
-- Enforces composite foreign keys for stores, products, findings, and action items
-- to prevent cross-workspace references at the RDBMS constraint level.
-- Idempotent, non-destructive, and safely scoped to table & current schema.

DO $$
BEGIN
  -- 1. Candidate key on stores(workspace_id, id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE c.conname = 'uq_stores_workspace_id'
      AND t.relname = 'stores'
      AND n.nspname = current_schema()
  ) THEN
    BEGIN
      ALTER TABLE stores ADD CONSTRAINT uq_stores_workspace_id UNIQUE (workspace_id, id);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Duplicate records violate uq_stores_workspace_id. Diagnostic query: SELECT workspace_id, id, COUNT(*) FROM stores GROUP BY workspace_id, id HAVING COUNT(*) > 1;';
    END;
  END IF;

  -- 2. Composite FK: products(workspace_id, store_id) -> stores(workspace_id, id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE c.conname = 'fk_products_store_workspace'
      AND t.relname = 'products'
      AND n.nspname = current_schema()
  ) THEN
    BEGIN
      ALTER TABLE products ADD CONSTRAINT fk_products_store_workspace
        FOREIGN KEY (workspace_id, store_id)
        REFERENCES stores (workspace_id, id) ON DELETE CASCADE;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Existing records violate fk_products_store_workspace. Diagnostic query: SELECT p.workspace_id, p.id, p.store_id FROM products p LEFT JOIN stores s ON p.workspace_id = s.workspace_id AND p.store_id = s.id WHERE s.id IS NULL;';
    END;
  END IF;

  -- 3. Composite FK: findings(workspace_id, store_id) -> stores(workspace_id, id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE c.conname = 'fk_findings_store_workspace'
      AND t.relname = 'findings'
      AND n.nspname = current_schema()
  ) THEN
    BEGIN
      ALTER TABLE findings ADD CONSTRAINT fk_findings_store_workspace
        FOREIGN KEY (workspace_id, store_id)
        REFERENCES stores (workspace_id, id) ON DELETE CASCADE;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Existing records violate fk_findings_store_workspace. Diagnostic query: SELECT f.workspace_id, f.id, f.store_id FROM findings f LEFT JOIN stores s ON f.workspace_id = s.workspace_id AND f.store_id = s.id WHERE s.id IS NULL;';
    END;
  END IF;

  -- 4. Composite FK: findings(workspace_id, product_id) -> products(workspace_id, id)
  -- (NULL product_id allowed for store-scoped findings via MATCH SIMPLE)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE c.conname = 'fk_findings_product_workspace'
      AND t.relname = 'findings'
      AND n.nspname = current_schema()
  ) THEN
    BEGIN
      ALTER TABLE findings ADD CONSTRAINT fk_findings_product_workspace
        FOREIGN KEY (workspace_id, product_id)
        REFERENCES products (workspace_id, id) ON DELETE CASCADE;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Existing records violate fk_findings_product_workspace. Diagnostic query: SELECT f.workspace_id, f.id, f.product_id FROM findings f LEFT JOIN products p ON f.workspace_id = p.workspace_id AND f.product_id = p.id WHERE f.product_id IS NOT NULL AND p.id IS NULL;';
    END;
  END IF;

  -- 5. Composite FK: action_items(workspace_id, store_id) -> stores(workspace_id, id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE c.conname = 'fk_action_items_store_workspace'
      AND t.relname = 'action_items'
      AND n.nspname = current_schema()
  ) THEN
    BEGIN
      ALTER TABLE action_items ADD CONSTRAINT fk_action_items_store_workspace
        FOREIGN KEY (workspace_id, store_id)
        REFERENCES stores (workspace_id, id) ON DELETE CASCADE;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Existing records violate fk_action_items_store_workspace. Diagnostic query: SELECT a.workspace_id, a.id, a.store_id FROM action_items a LEFT JOIN stores s ON a.workspace_id = s.workspace_id AND a.store_id = s.id WHERE s.id IS NULL;';
    END;
  END IF;

  -- 6. Composite FK: action_items(workspace_id, finding_id) -> findings(workspace_id, id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE c.conname = 'fk_action_items_finding_workspace'
      AND t.relname = 'action_items'
      AND n.nspname = current_schema()
  ) THEN
    BEGIN
      ALTER TABLE action_items ADD CONSTRAINT fk_action_items_finding_workspace
        FOREIGN KEY (workspace_id, finding_id)
        REFERENCES findings (workspace_id, id) ON DELETE CASCADE;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Existing records violate fk_action_items_finding_workspace. Diagnostic query: SELECT a.workspace_id, a.id, a.finding_id FROM action_items a LEFT JOIN findings f ON a.workspace_id = f.workspace_id AND a.finding_id = f.id WHERE f.id IS NULL;';
    END;
  END IF;

  -- 7. Composite FK: action_items(workspace_id, product_id) -> products(workspace_id, id)
  -- (NULL product_id allowed for store-scoped actions via MATCH SIMPLE)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE c.conname = 'fk_action_items_product_workspace'
      AND t.relname = 'action_items'
      AND n.nspname = current_schema()
  ) THEN
    BEGIN
      ALTER TABLE action_items ADD CONSTRAINT fk_action_items_product_workspace
        FOREIGN KEY (workspace_id, product_id)
        REFERENCES products (workspace_id, id) ON DELETE CASCADE;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Existing records violate fk_action_items_product_workspace. Diagnostic query: SELECT a.workspace_id, a.id, a.product_id FROM action_items a LEFT JOIN products p ON a.workspace_id = p.workspace_id AND a.product_id = p.id WHERE a.product_id IS NOT NULL AND p.id IS NULL;';
    END;
  END IF;
END $$;
