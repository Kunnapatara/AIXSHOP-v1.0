-- AIXSHOP v1.0 — Migration 004: Safe Backfill of Store SKU Counts (004_backfill_store_sku_count.sql)
-- Re-synchronizes stores.sku_count with the authoritative definition:
-- Each variant represents 1 SKU; products with 0 variants count as 1 SKU.
-- Non-destructive, idempotent backfill for existing workspaces.

UPDATE stores s
SET sku_count = COALESCE((
  SELECT SUM(
    CASE 
      WHEN var_counts.v_count > 0 THEN var_counts.v_count 
      ELSE 1 
    END
  )
  FROM products p
  LEFT JOIN (
    SELECT product_id, workspace_id, COUNT(*) AS v_count
    FROM variants
    GROUP BY product_id, workspace_id
  ) var_counts ON var_counts.product_id = p.id AND var_counts.workspace_id = p.workspace_id
  WHERE p.workspace_id = s.workspace_id
), 0);
