-- AIXSHOP v1.0 — Tenant Referential Integrity Hardening (002_tenant_referential_integrity.sql)
-- Enforces composite foreign keys for stores, products, findings, and action items
-- to prevent cross-workspace references at the RDBMS constraint level.
-- Idempotent, non-destructive, strictly validated against incompatible definitions.

DO $$
DECLARE
  v_contype char;
  v_src_tbl text;
  v_tgt_tbl text;
  v_src_schema text;
  v_tgt_schema text;
  v_src_cols text[];
  v_tgt_cols text[];
BEGIN
  -- 1. Candidate key on stores(workspace_id, id)
  SELECT
    c.contype,
    t.relname,
    n.nspname,
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[])
  INTO
    v_contype,
    v_src_tbl,
    v_src_schema,
    v_src_cols
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
  WHERE c.conname = 'uq_stores_workspace_id'
    AND n.nspname = current_schema();

  IF FOUND THEN
    IF v_contype NOT IN ('u', 'p')
       OR v_src_tbl IS DISTINCT FROM 'stores'
       OR v_src_schema IS DISTINCT FROM current_schema()
       OR v_src_cols IS DISTINCT FROM ARRAY['workspace_id', 'id'] THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Incompatible constraint "uq_stores_workspace_id" already exists (table: %.%, type: %, columns: %). Expected UNIQUE stores(workspace_id, id).',
        v_src_schema, v_src_tbl, v_contype, v_src_cols;
    END IF;
  ELSE
    BEGIN
      ALTER TABLE stores ADD CONSTRAINT uq_stores_workspace_id UNIQUE (workspace_id, id);
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Duplicate records violate uq_stores_workspace_id. Diagnostic query: SELECT workspace_id, id, COUNT(*) FROM stores GROUP BY workspace_id, id HAVING COUNT(*) > 1;';
    END;
  END IF;

  -- 2. Composite FK: products(workspace_id, store_id) -> stores(workspace_id, id)
  SELECT
    c.contype,
    src_t.relname,
    tgt_t.relname,
    src_ns.nspname,
    tgt_ns.nspname,
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[]),
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.confrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[])
  INTO
    v_contype,
    v_src_tbl,
    v_tgt_tbl,
    v_src_schema,
    v_tgt_schema,
    v_src_cols,
    v_tgt_cols
  FROM pg_constraint c
  JOIN pg_class src_t ON c.conrelid = src_t.oid
  JOIN pg_namespace src_ns ON src_t.relnamespace = src_ns.oid
  LEFT JOIN pg_class tgt_t ON c.confrelid = tgt_t.oid
  LEFT JOIN pg_namespace tgt_ns ON tgt_t.relnamespace = tgt_ns.oid
  WHERE c.conname = 'fk_products_store_workspace'
    AND src_ns.nspname = current_schema();

  IF FOUND THEN
    IF v_contype IS DISTINCT FROM 'f'
       OR v_src_tbl IS DISTINCT FROM 'products'
       OR v_tgt_tbl IS DISTINCT FROM 'stores'
       OR v_src_schema IS DISTINCT FROM current_schema()
       OR v_tgt_schema IS DISTINCT FROM current_schema()
       OR v_src_cols IS DISTINCT FROM ARRAY['workspace_id', 'store_id']
       OR v_tgt_cols IS DISTINCT FROM ARRAY['workspace_id', 'id'] THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Incompatible foreign key "fk_products_store_workspace" already exists (source: %.%(%), target: %.%(%), type: %). Expected products(workspace_id, store_id) -> stores(workspace_id, id).',
        v_src_schema, v_src_tbl, v_src_cols, v_tgt_schema, v_tgt_tbl, v_tgt_cols, v_contype;
    END IF;
  ELSE
    BEGIN
      ALTER TABLE products ADD CONSTRAINT fk_products_store_workspace
        FOREIGN KEY (workspace_id, store_id)
        REFERENCES stores (workspace_id, id) ON DELETE CASCADE;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Existing records violate fk_products_store_workspace. Diagnostic query: SELECT p.workspace_id, p.id, p.store_id FROM products p LEFT JOIN stores s ON p.workspace_id = s.workspace_id AND p.store_id = s.id WHERE s.id IS NULL;';
    END;
  END IF;

  -- 3. Composite FK: findings(workspace_id, store_id) -> stores(workspace_id, id)
  SELECT
    c.contype,
    src_t.relname,
    tgt_t.relname,
    src_ns.nspname,
    tgt_ns.nspname,
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[]),
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.confrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[])
  INTO
    v_contype,
    v_src_tbl,
    v_tgt_tbl,
    v_src_schema,
    v_tgt_schema,
    v_src_cols,
    v_tgt_cols
  FROM pg_constraint c
  JOIN pg_class src_t ON c.conrelid = src_t.oid
  JOIN pg_namespace src_ns ON src_t.relnamespace = src_ns.oid
  LEFT JOIN pg_class tgt_t ON c.confrelid = tgt_t.oid
  LEFT JOIN pg_namespace tgt_ns ON tgt_t.relnamespace = tgt_ns.oid
  WHERE c.conname = 'fk_findings_store_workspace'
    AND src_ns.nspname = current_schema();

  IF FOUND THEN
    IF v_contype IS DISTINCT FROM 'f'
       OR v_src_tbl IS DISTINCT FROM 'findings'
       OR v_tgt_tbl IS DISTINCT FROM 'stores'
       OR v_src_schema IS DISTINCT FROM current_schema()
       OR v_tgt_schema IS DISTINCT FROM current_schema()
       OR v_src_cols IS DISTINCT FROM ARRAY['workspace_id', 'store_id']
       OR v_tgt_cols IS DISTINCT FROM ARRAY['workspace_id', 'id'] THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Incompatible foreign key "fk_findings_store_workspace" already exists (source: %.%(%), target: %.%(%), type: %). Expected findings(workspace_id, store_id) -> stores(workspace_id, id).',
        v_src_schema, v_src_tbl, v_src_cols, v_tgt_schema, v_tgt_tbl, v_tgt_cols, v_contype;
    END IF;
  ELSE
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
  SELECT
    c.contype,
    src_t.relname,
    tgt_t.relname,
    src_ns.nspname,
    tgt_ns.nspname,
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[]),
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.confrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[])
  INTO
    v_contype,
    v_src_tbl,
    v_tgt_tbl,
    v_src_schema,
    v_tgt_schema,
    v_src_cols,
    v_tgt_cols
  FROM pg_constraint c
  JOIN pg_class src_t ON c.conrelid = src_t.oid
  JOIN pg_namespace src_ns ON src_t.relnamespace = src_ns.oid
  LEFT JOIN pg_class tgt_t ON c.confrelid = tgt_t.oid
  LEFT JOIN pg_namespace tgt_ns ON tgt_t.relnamespace = tgt_ns.oid
  WHERE c.conname = 'fk_findings_product_workspace'
    AND src_ns.nspname = current_schema();

  IF FOUND THEN
    IF v_contype IS DISTINCT FROM 'f'
       OR v_src_tbl IS DISTINCT FROM 'findings'
       OR v_tgt_tbl IS DISTINCT FROM 'products'
       OR v_src_schema IS DISTINCT FROM current_schema()
       OR v_tgt_schema IS DISTINCT FROM current_schema()
       OR v_src_cols IS DISTINCT FROM ARRAY['workspace_id', 'product_id']
       OR v_tgt_cols IS DISTINCT FROM ARRAY['workspace_id', 'id'] THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Incompatible foreign key "fk_findings_product_workspace" already exists (source: %.%(%), target: %.%(%), type: %). Expected findings(workspace_id, product_id) -> products(workspace_id, id).',
        v_src_schema, v_src_tbl, v_src_cols, v_tgt_schema, v_tgt_tbl, v_tgt_cols, v_contype;
    END IF;
  ELSE
    BEGIN
      ALTER TABLE findings ADD CONSTRAINT fk_findings_product_workspace
        FOREIGN KEY (workspace_id, product_id)
        REFERENCES products (workspace_id, id) ON DELETE CASCADE;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Existing records violate fk_findings_product_workspace. Diagnostic query: SELECT f.workspace_id, f.id, f.product_id FROM findings f LEFT JOIN products p ON f.workspace_id = p.workspace_id AND f.product_id = p.id WHERE f.product_id IS NOT NULL AND p.id IS NULL;';
    END;
  END IF;

  -- 5. Composite FK: action_items(workspace_id, store_id) -> stores(workspace_id, id)
  SELECT
    c.contype,
    src_t.relname,
    tgt_t.relname,
    src_ns.nspname,
    tgt_ns.nspname,
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[]),
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.confrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[])
  INTO
    v_contype,
    v_src_tbl,
    v_tgt_tbl,
    v_src_schema,
    v_tgt_schema,
    v_src_cols,
    v_tgt_cols
  FROM pg_constraint c
  JOIN pg_class src_t ON c.conrelid = src_t.oid
  JOIN pg_namespace src_ns ON src_t.relnamespace = src_ns.oid
  LEFT JOIN pg_class tgt_t ON c.confrelid = tgt_t.oid
  LEFT JOIN pg_namespace tgt_ns ON tgt_t.relnamespace = tgt_ns.oid
  WHERE c.conname = 'fk_action_items_store_workspace'
    AND src_ns.nspname = current_schema();

  IF FOUND THEN
    IF v_contype IS DISTINCT FROM 'f'
       OR v_src_tbl IS DISTINCT FROM 'action_items'
       OR v_tgt_tbl IS DISTINCT FROM 'stores'
       OR v_src_schema IS DISTINCT FROM current_schema()
       OR v_tgt_schema IS DISTINCT FROM current_schema()
       OR v_src_cols IS DISTINCT FROM ARRAY['workspace_id', 'store_id']
       OR v_tgt_cols IS DISTINCT FROM ARRAY['workspace_id', 'id'] THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Incompatible foreign key "fk_action_items_store_workspace" already exists (source: %.%(%), target: %.%(%), type: %). Expected action_items(workspace_id, store_id) -> stores(workspace_id, id).',
        v_src_schema, v_src_tbl, v_src_cols, v_tgt_schema, v_tgt_tbl, v_tgt_cols, v_contype;
    END IF;
  ELSE
    BEGIN
      ALTER TABLE action_items ADD CONSTRAINT fk_action_items_store_workspace
        FOREIGN KEY (workspace_id, store_id)
        REFERENCES stores (workspace_id, id) ON DELETE CASCADE;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Existing records violate fk_action_items_store_workspace. Diagnostic query: SELECT a.workspace_id, a.id, a.store_id FROM action_items a LEFT JOIN stores s ON a.workspace_id = s.workspace_id AND a.store_id = s.id WHERE s.id IS NULL;';
    END;
  END IF;

  -- 6. Composite FK: action_items(workspace_id, finding_id) -> findings(workspace_id, id)
  SELECT
    c.contype,
    src_t.relname,
    tgt_t.relname,
    src_ns.nspname,
    tgt_ns.nspname,
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[]),
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.confrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[])
  INTO
    v_contype,
    v_src_tbl,
    v_tgt_tbl,
    v_src_schema,
    v_tgt_schema,
    v_src_cols,
    v_tgt_cols
  FROM pg_constraint c
  JOIN pg_class src_t ON c.conrelid = src_t.oid
  JOIN pg_namespace src_ns ON src_t.relnamespace = src_ns.oid
  LEFT JOIN pg_class tgt_t ON c.confrelid = tgt_t.oid
  LEFT JOIN pg_namespace tgt_ns ON tgt_t.relnamespace = tgt_ns.oid
  WHERE c.conname = 'fk_action_items_finding_workspace'
    AND src_ns.nspname = current_schema();

  IF FOUND THEN
    IF v_contype IS DISTINCT FROM 'f'
       OR v_src_tbl IS DISTINCT FROM 'action_items'
       OR v_tgt_tbl IS DISTINCT FROM 'findings'
       OR v_src_schema IS DISTINCT FROM current_schema()
       OR v_tgt_schema IS DISTINCT FROM current_schema()
       OR v_src_cols IS DISTINCT FROM ARRAY['workspace_id', 'finding_id']
       OR v_tgt_cols IS DISTINCT FROM ARRAY['workspace_id', 'id'] THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Incompatible foreign key "fk_action_items_finding_workspace" already exists (source: %.%(%), target: %.%(%), type: %). Expected action_items(workspace_id, finding_id) -> findings(workspace_id, id).',
        v_src_schema, v_src_tbl, v_src_cols, v_tgt_schema, v_tgt_tbl, v_tgt_cols, v_contype;
    END IF;
  ELSE
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
  SELECT
    c.contype,
    src_t.relname,
    tgt_t.relname,
    src_ns.nspname,
    tgt_ns.nspname,
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[]),
    COALESCE((
      SELECT array_agg(att.attname::text ORDER BY u.attpos)
      FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos)
      JOIN pg_attribute att ON att.attrelid = c.confrelid AND att.attnum = u.attnum
    ), ARRAY[]::text[])
  INTO
    v_contype,
    v_src_tbl,
    v_tgt_tbl,
    v_src_schema,
    v_tgt_schema,
    v_src_cols,
    v_tgt_cols
  FROM pg_constraint c
  JOIN pg_class src_t ON c.conrelid = src_t.oid
  JOIN pg_namespace src_ns ON src_t.relnamespace = src_ns.oid
  LEFT JOIN pg_class tgt_t ON c.confrelid = tgt_t.oid
  LEFT JOIN pg_namespace tgt_ns ON tgt_t.relnamespace = tgt_ns.oid
  WHERE c.conname = 'fk_action_items_product_workspace'
    AND src_ns.nspname = current_schema();

  IF FOUND THEN
    IF v_contype IS DISTINCT FROM 'f'
       OR v_src_tbl IS DISTINCT FROM 'action_items'
       OR v_tgt_tbl IS DISTINCT FROM 'products'
       OR v_src_schema IS DISTINCT FROM current_schema()
       OR v_tgt_schema IS DISTINCT FROM current_schema()
       OR v_src_cols IS DISTINCT FROM ARRAY['workspace_id', 'product_id']
       OR v_tgt_cols IS DISTINCT FROM ARRAY['workspace_id', 'id'] THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Incompatible foreign key "fk_action_items_product_workspace" already exists (source: %.%(%), target: %.%(%), type: %). Expected action_items(workspace_id, product_id) -> products(workspace_id, id).',
        v_src_schema, v_src_tbl, v_src_cols, v_tgt_schema, v_tgt_tbl, v_tgt_cols, v_contype;
    END IF;
  ELSE
    BEGIN
      ALTER TABLE action_items ADD CONSTRAINT fk_action_items_product_workspace
        FOREIGN KEY (workspace_id, product_id)
        REFERENCES products (workspace_id, id) ON DELETE CASCADE;
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION '[AIXSHOP Migration 002 Error] Existing records violate fk_action_items_product_workspace. Diagnostic query: SELECT a.workspace_id, a.id, a.product_id FROM action_items a LEFT JOIN products p ON a.workspace_id = p.workspace_id AND a.product_id = p.id WHERE a.product_id IS NOT NULL AND p.id IS NULL;';
    END;
  END IF;
END $$;
