import { Pool, PoolClient } from 'pg';
import { 
  DatabaseRepository, 
  CreateUserData, 
  CreateWorkspaceData, 
  CreateSessionData,
  RegisterUserData,
  RegisterUserResult,
  SchemaReadinessResult,
  AuditRunRecord,
  CreateAuditRunData,
  UpdateAuditRunData
} from './repository';
import { executeCatalogAudit } from '../../domain/audit/auditEngine';
import { 
  UserRecord, 
  WorkspaceRecord, 
  WorkspaceMembershipRecord, 
  SessionRecord, 
  WorkspaceRole 
} from '../types';
import { 
  Product, 
  Variant, 
  Offer, 
  EvidenceDocument, 
  Finding, 
  ActionItem, 
  StoreProfile,
  CatalogImportResult,
  ProductCandidate
} from '../../types';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
import { SubscriptionRecord, BillingEventRecord, PlanTier } from '../billing/types';
import { executeActionApproval, executeActionDismissal, executeActionRecheck, executeCatalogImport } from '../../domain/catalog/catalogMutationService';
import { 
  calculateImportUsage, 
  checkPlanQuota, 
  countCatalogSkus, 
  PlanQuotaExceededError 
} from '../services/entitlementService';

export class PostgresRepository implements DatabaseRepository {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  getBackendType(): 'postgres' {
    return 'postgres';
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.pool.query('SELECT 1');
      return res.rowCount !== null && res.rowCount > 0;
    } catch {
      return false;
    }
  }

  async checkSchemaReadiness(): Promise<SchemaReadinessResult> {
    const requiredTables = [
      'users',
      'workspaces',
      'workspace_memberships',
      'sessions',
      'stores',
      'products',
      'variants',
      'offers',
      'evidence_documents',
      'findings',
      'action_items',
      'schema_migrations',
      'subscriptions',
      'billing_events',
      'audit_runs',
      'audit_run_manifests',
      'audit_run_findings',
      'audit_run_evidence',
      'audit_run_products',
      'shopify_connections',
      'shopify_sync_runs',
      'shopify_webhook_events',
      'shopify_oauth_states',
      'workspace_business_profiles',
      'ai_visibility_imports',
      'ai_visibility_metrics',
    ];

    try {
      const client = await this.pool.connect();
      try {
        const res = await client.query<{ table_name: string }>(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = current_schema()
        `);
        const existingTables = new Set(res.rows.map(r => r.table_name.toLowerCase()));
        const missingTables = requiredTables.filter(t => !existingTables.has(t.toLowerCase()));

        if (missingTables.length > 0) {
          return {
            isReady: false,
            missingTables,
            error: `Missing required database tables: ${missingTables.join(', ')}. Please run "npm run db:migrate" to initialize the schema.`,
          };
        }

        // Verify key column integrity, types, precision/scale, length, and nullability
        const colRes = await client.query<{
          table_name: string;
          column_name: string;
          data_type: string;
          numeric_precision: number | null;
          numeric_scale: number | null;
          is_nullable: string;
          character_maximum_length: number | null;
        }>(`
          SELECT 
            table_name, 
            column_name, 
            data_type, 
            numeric_precision, 
            numeric_scale, 
            is_nullable,
            character_maximum_length
          FROM information_schema.columns 
          WHERE table_schema = current_schema()
            AND (
              (table_name = 'variants' AND column_name = 'price') OR
              (table_name = 'sessions' AND column_name = 'session_token_hash') OR
              (table_name = 'products' AND column_name = 'workspace_id')
            )
        `);

        const colMap = new Map(colRes.rows.map(r => [`${r.table_name}.${r.column_name}`, r]));

        // 2.1 Verify variants.price
        const priceCol = colMap.get('variants.price');
        if (!priceCol) {
          return {
            isReady: false,
            error: 'Database schema integrity error: variants table missing price column.',
          };
        }
        if (priceCol.data_type !== 'numeric') {
          return {
            isReady: false,
            error: `Database schema integrity error: variants.price has data type "${priceCol.data_type}", expected "numeric".`,
          };
        }
        if (priceCol.numeric_precision !== 14 || priceCol.numeric_scale !== 2) {
          return {
            isReady: false,
            error: `Database schema integrity error: variants.price precision/scale is (${priceCol.numeric_precision}, ${priceCol.numeric_scale}), expected NUMERIC(14, 2).`,
          };
        }

        // 2.2 Verify sessions.session_token_hash
        const sessionTokenCol = colMap.get('sessions.session_token_hash');
        if (!sessionTokenCol) {
          return {
            isReady: false,
            error: 'Database schema integrity error: sessions table missing session_token_hash column.',
          };
        }
        if (sessionTokenCol.data_type !== 'character varying') {
          return {
            isReady: false,
            error: `Database schema integrity error: sessions.session_token_hash has data type "${sessionTokenCol.data_type}", expected "character varying".`,
          };
        }
        if (sessionTokenCol.character_maximum_length !== 128) {
          return {
            isReady: false,
            error: `Database schema integrity error: sessions.session_token_hash length is ${sessionTokenCol.character_maximum_length}, expected VARCHAR(128).`,
          };
        }
        if (sessionTokenCol.is_nullable !== 'NO') {
          return {
            isReady: false,
            error: 'Database schema integrity error: sessions.session_token_hash must be NOT NULL.',
          };
        }

        // 2.3 Verify products.workspace_id
        const productWsCol = colMap.get('products.workspace_id');
        if (!productWsCol) {
          return {
            isReady: false,
            error: 'Database schema integrity error: products table missing workspace_id column for multi-tenant isolation.',
          };
        }
        if (productWsCol.data_type !== 'character varying') {
          return {
            isReady: false,
            error: `Database schema integrity error: products.workspace_id has data type "${productWsCol.data_type}", expected "character varying".`,
          };
        }
        if (productWsCol.character_maximum_length !== 64) {
          return {
            isReady: false,
            error: `Database schema integrity error: products.workspace_id length is ${productWsCol.character_maximum_length}, expected VARCHAR(64).`,
          };
        }
        if (productWsCol.is_nullable !== 'NO') {
          return {
            isReady: false,
            error: 'Database schema integrity error: products.workspace_id must be NOT NULL.',
          };
        }

        // Verify active schema identity
        const schemaRes = await client.query<{ schema_name: string }>('SELECT current_schema() AS schema_name');
        const activeSchema = schemaRes.rows[0]?.schema_name;
        if (!activeSchema) {
          return {
            isReady: false,
            error: 'Database schema integrity error: Unable to determine active database schema via current_schema().',
          };
        }

        // Verify foreign key constraint on products(workspace_id) -> workspaces(id) ON DELETE CASCADE
        const fkRes = await client.query<{
          source_schema: string;
          source_table: string;
          source_column: string;
          target_schema: string;
          target_table: string;
          target_column: string;
          on_delete: string;
        }>(`
          SELECT 
            kcu.table_schema AS source_schema,
            kcu.table_name AS source_table,
            kcu.column_name AS source_column,
            ccu.table_schema AS target_schema,
            ccu.table_name AS target_table,
            ccu.column_name AS target_column,
            rc.delete_rule AS on_delete
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.referential_constraints rc
            ON tc.constraint_name = rc.constraint_name
            AND tc.table_schema = rc.constraint_schema
          JOIN information_schema.constraint_column_usage ccu
            ON rc.unique_constraint_name = ccu.constraint_name
            AND rc.unique_constraint_schema = ccu.constraint_schema
          WHERE tc.table_schema = current_schema()
            AND tc.table_name = 'products'
            AND kcu.column_name = 'workspace_id'
            AND tc.constraint_type = 'FOREIGN KEY';
        `);

        if (fkRes.rows.length === 0) {
          return {
            isReady: false,
            error: 'Database schema integrity error: products table missing foreign key constraint on workspace_id.',
          };
        }

        const fk = fkRes.rows[0];
        const fkSourceSchema = fk.source_schema || activeSchema;
        const fkTargetSchema = fk.target_schema || activeSchema;

        if (fkSourceSchema !== activeSchema) {
          return {
            isReady: false,
            error: `Database schema integrity error: products(workspace_id) foreign key source schema is "${fk.source_schema}", expected active schema "${activeSchema}".`,
          };
        }

        if (fkTargetSchema !== activeSchema) {
          return {
            isReady: false,
            error: `Database schema integrity error: products(workspace_id) foreign key references target schema "${fk.target_schema}", expected active schema "${activeSchema}".`,
          };
        }

        if (fk.target_table !== 'workspaces') {
          return {
            isReady: false,
            error: `Database schema integrity error: products(workspace_id) foreign key references wrong table "${fk.target_table}", expected "workspaces".`,
          };
        }

        if (fk.target_column !== 'id') {
          return {
            isReady: false,
            error: `Database schema integrity error: products(workspace_id) foreign key references wrong column "${fk.target_column}", expected "id".`,
          };
        }

        if (fk.on_delete !== 'CASCADE') {
          return {
            isReady: false,
            error: `Database schema integrity error: products(workspace_id) foreign key delete rule is "${fk.on_delete}", expected "CASCADE".`,
          };
        }

        // Verify applied migrations (001, 002, 003, and 004 are all required for current version)
        const migRes = await client.query<{ id: string }>(
          'SELECT id FROM schema_migrations ORDER BY id ASC'
        );
        const appliedMigrations = migRes.rows.map(r => r.id);

        const requiredMigrations = [
          '001_initial_schema.sql',
          '002_tenant_referential_integrity.sql',
          '003_store_sku_limit.sql',
          '004_backfill_store_sku_count.sql',
          '005_billing_subscriptions.sql',
          '006_audit_history_snapshots.sql',
          '007_shopify_integration.sql',
          '008_audit_composite_integrity_and_shopify_hardening.sql',
          '009_durable_sync_runs_and_ai_discovery.sql',
          '010_remediation_integrity_and_leases.sql',
        ];
        const pendingMigrations = requiredMigrations.filter(m => !appliedMigrations.includes(m));

        if (pendingMigrations.length > 0) {
          return {
            isReady: false,
            pendingMigrations,
            error: `Required migration "${pendingMigrations[0]}" has not been applied. Run "npm run db:migrate".`,
          };
        }

        // Verify required composite foreign-key and unique constraints in catalog metadata
        const catalogConstraintsRes = await client.query<{
          source_schema: string;
          source_table: string;
          target_schema: string;
          target_table: string;
          constraint_name: string;
          constraint_type: string;
          source_columns: string;
          target_columns: string;
        }>(`
          SELECT
            src_ns.nspname AS source_schema,
            src_t.relname AS source_table,
            COALESCE(tgt_ns.nspname, '') AS target_schema,
            COALESCE(tgt_t.relname, '') AS target_table,
            c.conname AS constraint_name,
            c.contype AS constraint_type,
            COALESCE((
              SELECT string_agg(att.attname, ',' ORDER BY u.attpos)
              FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, attpos)
              JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = u.attnum
            ), '') AS source_columns,
            COALESCE((
              SELECT string_agg(att.attname, ',' ORDER BY u.attpos)
              FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, attpos)
              JOIN pg_attribute att ON att.attrelid = c.confrelid AND att.attnum = u.attnum
            ), '') AS target_columns
          FROM pg_constraint c
          JOIN pg_class src_t ON c.conrelid = src_t.oid
          JOIN pg_namespace src_ns ON src_t.relnamespace = src_ns.oid
          LEFT JOIN pg_class tgt_t ON c.confrelid = tgt_t.oid
          LEFT JOIN pg_namespace tgt_ns ON tgt_t.relnamespace = tgt_ns.oid
          WHERE src_ns.nspname = current_schema()
            AND c.contype IN ('f', 'u', 'p');
        `);

        const parseCols = (cols: string): string[] =>
          cols
            ? cols.split(',').map(c => c.trim().toLowerCase()).filter(Boolean)
            : [];

        const arraysEqual = (a: string[], b: string[]): boolean =>
          a.length === b.length && a.every((val, idx) => val === b[idx]);

        const catalogRows = catalogConstraintsRes.rows;

        // 4.1 Verify unique constraint on stores(workspace_id, id) with exact ordinal order
        const expectedStoreCols = ['workspace_id', 'id'];
        const storeUniqueConstraint = catalogRows.find(
          r =>
            (r.source_schema || activeSchema) === activeSchema &&
            r.source_table === 'stores' &&
            ['u', 'p'].includes(r.constraint_type) &&
            arraysEqual(parseCols(r.source_columns), expectedStoreCols)
        );

        if (!storeUniqueConstraint) {
          return {
            isReady: false,
            error: 'Database schema integrity error: stores table missing unique key on (workspace_id, id). Run "npm run db:migrate".',
          };
        }

        // 4.1b Verify unique constraint on audit_runs(workspace_id, id)
        const expectedAuditRunCols = ['workspace_id', 'id'];
        const auditRunUniqueConstraint = catalogRows.find(
          r =>
            (r.source_schema || activeSchema) === activeSchema &&
            r.source_table === 'audit_runs' &&
            ['u', 'p'].includes(r.constraint_type) &&
            arraysEqual(parseCols(r.source_columns), expectedAuditRunCols)
        );

        if (!auditRunUniqueConstraint) {
          return {
            isReady: false,
            error: 'Database schema integrity error: audit_runs table missing unique key on (workspace_id, id). Run "npm run db:migrate".',
          };
        }

        // 4.2 Verify required composite foreign keys with exact ordinal mapping and active schema scoping
        const requiredCompositeFks = [
          {
            sourceTable: 'products',
            sourceColumns: ['workspace_id', 'store_id'],
            targetTable: 'stores',
            targetColumns: ['workspace_id', 'id'],
            description: 'products(workspace_id, store_id) -> stores(workspace_id, id)',
          },
          {
            sourceTable: 'findings',
            sourceColumns: ['workspace_id', 'store_id'],
            targetTable: 'stores',
            targetColumns: ['workspace_id', 'id'],
            description: 'findings(workspace_id, store_id) -> stores(workspace_id, id)',
          },
          {
            sourceTable: 'findings',
            sourceColumns: ['workspace_id', 'product_id'],
            targetTable: 'products',
            targetColumns: ['workspace_id', 'id'],
            description: 'findings(workspace_id, product_id) -> products(workspace_id, id)',
          },
          {
            sourceTable: 'action_items',
            sourceColumns: ['workspace_id', 'store_id'],
            targetTable: 'stores',
            targetColumns: ['workspace_id', 'id'],
            description: 'action_items(workspace_id, store_id) -> stores(workspace_id, id)',
          },
          {
            sourceTable: 'action_items',
            sourceColumns: ['workspace_id', 'finding_id'],
            targetTable: 'findings',
            targetColumns: ['workspace_id', 'id'],
            description: 'action_items(workspace_id, finding_id) -> findings(workspace_id, id)',
          },
          {
            sourceTable: 'action_items',
            sourceColumns: ['workspace_id', 'product_id'],
            targetTable: 'products',
            targetColumns: ['workspace_id', 'id'],
            description: 'action_items(workspace_id, product_id) -> products(workspace_id, id)',
          },
          {
            sourceTable: 'audit_run_manifests',
            sourceColumns: ['workspace_id', 'audit_run_id'],
            targetTable: 'audit_runs',
            targetColumns: ['workspace_id', 'id'],
            description: 'audit_run_manifests(workspace_id, audit_run_id) -> audit_runs(workspace_id, id)',
          },
          {
            sourceTable: 'audit_run_findings',
            sourceColumns: ['workspace_id', 'audit_run_id'],
            targetTable: 'audit_runs',
            targetColumns: ['workspace_id', 'id'],
            description: 'audit_run_findings(workspace_id, audit_run_id) -> audit_runs(workspace_id, id)',
          },
          {
            sourceTable: 'audit_run_evidence',
            sourceColumns: ['workspace_id', 'audit_run_id'],
            targetTable: 'audit_runs',
            targetColumns: ['workspace_id', 'id'],
            description: 'audit_run_evidence(workspace_id, audit_run_id) -> audit_runs(workspace_id, id)',
          },
          {
            sourceTable: 'audit_run_products',
            sourceColumns: ['workspace_id', 'audit_run_id'],
            targetTable: 'audit_runs',
            targetColumns: ['workspace_id', 'id'],
            description: 'audit_run_products(workspace_id, audit_run_id) -> audit_runs(workspace_id, id)',
          },
        ];

        for (const reqFk of requiredCompositeFks) {
          const matchingFk = catalogRows.find(
            r =>
              (r.source_schema || activeSchema) === activeSchema &&
              r.source_table === reqFk.sourceTable &&
              (r.target_schema || activeSchema) === activeSchema &&
              r.target_table === reqFk.targetTable &&
              r.constraint_type === 'f' &&
              arraysEqual(parseCols(r.source_columns), reqFk.sourceColumns) &&
              arraysEqual(parseCols(r.target_columns), reqFk.targetColumns)
          );

          if (!matchingFk) {
            return {
              isReady: false,
              error: `Database schema integrity error: missing required composite foreign key constraint: ${reqFk.description}. Run "npm run db:migrate".`,
            };
          }

          // Positional mapping verification
          const actualSrcCols = parseCols(matchingFk.source_columns);
          const actualTgtCols = parseCols(matchingFk.target_columns);
          for (let i = 0; i < reqFk.sourceColumns.length; i++) {
            if (actualSrcCols[i] !== reqFk.sourceColumns[i] || actualTgtCols[i] !== reqFk.targetColumns[i]) {
              return {
                isReady: false,
                error: `Database schema integrity error: composite foreign key ${reqFk.description} column mapping mismatch at ordinal position ${i}: expected (${reqFk.sourceColumns[i]} -> ${reqFk.targetColumns[i]}), got (${actualSrcCols[i]} -> ${actualTgtCols[i]}).`,
              };
            }
          }
        }

        return {
          isReady: true,
          details: {
            checkedTables: requiredTables,
            appliedMigrations,
            verifiedConstraints: [
              'stores(workspace_id, id) UNIQUE',
              'audit_runs(workspace_id, id) UNIQUE',
              ...requiredCompositeFks.map(f => f.description),
              'products(workspace_id) -> workspaces(id)',
            ],
          },
        };
      } finally {
        client.release();
      }
    } catch (err: any) {
      return {
        isReady: false,
        error: `Database schema readiness check failed: ${err.message || 'Connection error'}`,
      };
    }
  }

  async registerUser(data: RegisterUserData): Promise<RegisterUserResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Insert user
      const userRes = await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING id, email, password_hash AS "passwordHash", full_name AS "fullName", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [data.user.id, data.user.email, data.user.passwordHash, data.user.fullName]
      );
      const user: UserRecord = userRes.rows[0];

      // 2. Insert workspace
      const wsRes = await client.query(
        `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         RETURNING id, name, slug, created_at AS "createdAt", updated_at AS "updatedAt"`,
        [data.workspace.id, data.workspace.name, data.workspace.slug]
      );
      const workspace: WorkspaceRecord = wsRes.rows[0];

      // 3. Insert workspace membership (owner)
      const memId = `mem_${data.workspace.id}_${data.user.id}`;
      const memRes = await client.query(
        `INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at)
         VALUES ($1, $2, $3, 'owner', NOW())
         RETURNING id, workspace_id AS "workspaceId", user_id AS "userId", role, created_at AS "createdAt"`,
        [memId, workspace.id, user.id]
      );
      const membership: WorkspaceMembershipRecord = memRes.rows[0];

      // 4. Create default store
      const storeId = `store_${workspace.id}`;
      const defaultConnectors = [
        {
          id: 'shopify_primary',
          type: 'shopify',
          name: 'Shopify Storefront Connector',
          status: 'not_configured',
          lastSync: 'Never',
          productCountSynced: 0,
          syncedSkuCount: 0,
          readOnly: true,
          writeBackAuthorized: false,
          missingReason: 'Real Shopify OAuth 2.0 application setup and customer credentials are required.',
        },
      ];
      await client.query(
        `INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW(), NOW())`,
        [
          storeId,
          workspace.id,
          `${workspace.name} Store`,
          `${workspace.slug}.myshopify.com`,
          'USD',
          0,
          0,
          'standard',
          'Free Audit',
          JSON.stringify(defaultConnectors),
        ]
      );

      // 5. Insert session
      const sessRes = await client.query(
        `INSERT INTO sessions (id, session_token_hash, user_id, active_workspace_id, expires_at, created_at, last_active_at, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), $6, $7)
         RETURNING id, session_token_hash AS "sessionTokenHash", user_id AS "userId", active_workspace_id AS "activeWorkspaceId", expires_at AS "expiresAt", created_at AS "createdAt", last_active_at AS "lastActiveAt", ip_address AS "ipAddress", user_agent AS "userAgent"`,
        [
          data.session.id,
          data.session.sessionTokenHash,
          user.id,
          workspace.id,
          data.session.expiresAt,
          data.session.ipAddress || null,
          data.session.userAgent || null,
        ]
      );
      const session: SessionRecord = sessRes.rows[0];

      await client.query('COMMIT');
      return { user, workspace, membership, session };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[AIXSHOP Database] Registration rollback failed:', rollbackErr);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async createUser(data: CreateUserData): Promise<UserRecord> {
    const query = `
      INSERT INTO users (id, email, password_hash, full_name, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING id, email, password_hash AS "passwordHash", full_name AS "fullName", created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const res = await this.pool.query(query, [data.id, data.email, data.passwordHash, data.fullName]);
    return res.rows[0];
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const query = `
      SELECT id, email, password_hash AS "passwordHash", full_name AS "fullName", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `;
    const res = await this.pool.query(query, [email]);
    return res.rows[0] || null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const query = `
      SELECT id, email, password_hash AS "passwordHash", full_name AS "fullName", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM users
      WHERE id = $1
      LIMIT 1
    `;
    const res = await this.pool.query(query, [id]);
    return res.rows[0] || null;
  }

  async createWorkspace(
    data: CreateWorkspaceData, 
    ownerUserId: string
  ): Promise<{ workspace: WorkspaceRecord; membership: WorkspaceMembershipRecord }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const wsQuery = `
        INSERT INTO workspaces (id, name, slug, created_at, updated_at)
        VALUES ($1, $2, $3, NOW(), NOW())
        RETURNING id, name, slug, created_at AS "createdAt", updated_at AS "updatedAt"
      `;
      const wsRes = await client.query(wsQuery, [data.id, data.name, data.slug]);
      const workspace: WorkspaceRecord = wsRes.rows[0];

      const membershipId = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const memQuery = `
        INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at)
        VALUES ($1, $2, $3, 'owner', NOW())
        RETURNING id, workspace_id AS "workspaceId", user_id AS "userId", role, created_at AS "createdAt"
      `;
      const memRes = await client.query(memQuery, [membershipId, workspace.id, ownerUserId]);
      const membership: WorkspaceMembershipRecord = memRes.rows[0];

      // Also create default store record for the workspace
      const storeId = `store_${workspace.id}`;
      const storeQuery = `
        INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'USD', 0, 0, 'balanced', 'Free Audit', '[]'::jsonb, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `;
      await client.query(storeQuery, [storeId, workspace.id, `${workspace.name} Store`, `${workspace.slug}.myshopify.com`]);

      await client.query('COMMIT');
      return { workspace, membership };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getWorkspaceById(workspaceId: string): Promise<WorkspaceRecord | null> {
    const query = `
      SELECT id, name, slug, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM workspaces
      WHERE id = $1
      LIMIT 1
    `;
    const res = await this.pool.query(query, [workspaceId]);
    return res.rows[0] || null;
  }

  async getUserWorkspaces(userId: string): Promise<Array<WorkspaceRecord & { role: WorkspaceRole }>> {
    const query = `
      SELECT w.id, w.name, w.slug, w.created_at AS "createdAt", w.updated_at AS "updatedAt", m.role
      FROM workspaces w
      INNER JOIN workspace_memberships m ON w.id = m.workspace_id
      WHERE m.user_id = $1
      ORDER BY w.created_at ASC
    `;
    const res = await this.pool.query(query, [userId]);
    return res.rows;
  }

  async getMembership(workspaceId: string, userId: string): Promise<WorkspaceMembershipRecord | null> {
    const query = `
      SELECT id, workspace_id AS "workspaceId", user_id AS "userId", role, created_at AS "createdAt"
      FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2
      LIMIT 1
    `;
    const res = await this.pool.query(query, [workspaceId, userId]);
    return res.rows[0] || null;
  }

  async createSession(data: CreateSessionData): Promise<SessionRecord> {
    const query = `
      INSERT INTO sessions (id, session_token_hash, user_id, active_workspace_id, expires_at, created_at, last_active_at, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), $6, $7)
      RETURNING id, session_token_hash AS "sessionTokenHash", user_id AS "userId", active_workspace_id AS "activeWorkspaceId", expires_at AS "expiresAt", created_at AS "createdAt", last_active_at AS "lastActiveAt", ip_address AS "ipAddress", user_agent AS "userAgent"
    `;
    const res = await this.pool.query(query, [
      data.id,
      data.sessionTokenHash,
      data.userId,
      data.activeWorkspaceId,
      data.expiresAt,
      data.ipAddress || null,
      data.userAgent || null,
    ]);
    return res.rows[0];
  }

  async getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const query = `
      SELECT id, session_token_hash AS "sessionTokenHash", user_id AS "userId", active_workspace_id AS "activeWorkspaceId", expires_at AS "expiresAt", created_at AS "createdAt", last_active_at AS "lastActiveAt", ip_address AS "ipAddress", user_agent AS "userAgent"
      FROM sessions
      WHERE session_token_hash = $1 AND expires_at > NOW()
      LIMIT 1
    `;
    const res = await this.pool.query(query, [tokenHash]);
    return res.rows[0] || null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE session_token_hash = $1', [tokenHash]);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }

  async updateSessionWorkspace(sessionId: string, newWorkspaceId: string): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET active_workspace_id = $1, last_active_at = NOW() WHERE id = $2',
      [newWorkspaceId, sessionId]
    );
  }

  async getStoreByWorkspace(workspaceId: string): Promise<StoreProfile | null> {
    const query = `
      SELECT id, name, domain, currency, sku_count AS "skuCount", sku_limit AS "skuLimit", catalog_completeness_avg AS "catalogCompletenessAvg", truth_boundary_strictness AS "truthBoundaryStrictness", tier, connectors_json AS "connectorsJson"
      FROM stores
      WHERE workspace_id = $1
      LIMIT 1
    `;
    const res = await this.pool.query(query, [workspaceId]);
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    const parsedLimit = (typeof r.skuLimit === 'number' && !isNaN(r.skuLimit)) ? r.skuLimit : undefined;
    return {
      name: r.name,
      domain: r.domain,
      platform: 'Shopify Storefront API v2025-01',
      skuCount: r.skuCount,
      skuLimit: parsedLimit,
      tier: r.tier,
      lastAuditDate: new Date().toISOString(),
      currency: r.currency,
      connectors: typeof r.connectorsJson === 'string' ? JSON.parse(r.connectorsJson) : r.connectorsJson,
      catalogCompletenessAvg: r.catalogCompletenessAvg,
      evidenceCoverageAvg: 70,
      truthBoundaryStrictness: r.truthBoundaryStrictness,
    };
  }

  async saveStoreProfile(workspaceId: string, profile: StoreProfile): Promise<StoreProfile> {
    const storeId = `store_${workspaceId}`;
    const cleanSkuLimit = (typeof profile.skuLimit === 'number' && Number.isInteger(profile.skuLimit) && profile.skuLimit >= 0)
      ? profile.skuLimit
      : null;
    const query = `
      INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, sku_limit, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        domain = EXCLUDED.domain,
        currency = EXCLUDED.currency,
        sku_count = EXCLUDED.sku_count,
        sku_limit = EXCLUDED.sku_limit,
        catalog_completeness_avg = EXCLUDED.catalog_completeness_avg,
        truth_boundary_strictness = EXCLUDED.truth_boundary_strictness,
        tier = EXCLUDED.tier,
        connectors_json = EXCLUDED.connectors_json,
        updated_at = NOW()
      RETURNING name, domain, currency, sku_count AS "skuCount", sku_limit AS "skuLimit", catalog_completeness_avg AS "catalogCompletenessAvg", truth_boundary_strictness AS "truthBoundaryStrictness", tier, connectors_json AS "connectorsJson"
    `;
    const res = await this.pool.query(query, [
      storeId,
      workspaceId,
      profile.name,
      profile.domain,
      profile.currency,
      profile.skuCount,
      cleanSkuLimit,
      profile.catalogCompletenessAvg,
      profile.truthBoundaryStrictness,
      profile.tier,
      JSON.stringify(profile.connectors || []),
    ]);
    const r = res.rows[0];
    return {
      name: r.name,
      domain: r.domain,
      platform: profile.platform || 'Shopify Storefront API v2025-01',
      skuCount: r.skuCount,
      skuLimit: (typeof r.skuLimit === 'number' && !isNaN(r.skuLimit)) ? r.skuLimit : undefined,
      tier: r.tier,
      lastAuditDate: profile.lastAuditDate || new Date().toISOString(),
      currency: r.currency,
      connectors: typeof r.connectorsJson === 'string' ? JSON.parse(r.connectorsJson) : r.connectorsJson,
      catalogCompletenessAvg: r.catalogCompletenessAvg,
      evidenceCoverageAvg: profile.evidenceCoverageAvg || 70,
      truthBoundaryStrictness: r.truthBoundaryStrictness,
    };
  }

  private async loadCatalogRows(
    queryable: { query: (text: string, params?: any[]) => Promise<any> },
    workspaceId: string,
    store: StoreProfile
  ): Promise<StoragePayloadV1> {
    const prodRes = await queryable.query(
      `SELECT id, title, brand, category, description, image, status, completeness_score AS "completenessScore", evidence_coverage_score AS "evidenceCoverageScore", external_discovery_status AS "externalDiscoveryStatus", attributes_json AS "attributesJson", findings_count AS "findingsCount", last_audited AS "lastAudited"
       FROM products
       WHERE workspace_id = $1`,
      [workspaceId]
    );

    const varRes = await queryable.query(
      `SELECT id, product_id AS "productId", sku, title, barcode, price, inventory_count AS "inventoryCount", attributes_json AS "attributesJson"
       FROM variants
       WHERE workspace_id = $1`,
      [workspaceId]
    );

    const offRes = await queryable.query(
      `SELECT id, product_id AS "productId", channel, price, currency, availability, condition, url, merchant_id AS "merchantId", last_sync AS "lastSync"
       FROM offers
       WHERE workspace_id = $1`,
      [workspaceId]
    );

    const eviRes = await queryable.query(
      `SELECT id, product_id AS "productId", title, type, issuer, date_verified AS "dateVerified", url, status
       FROM evidence_documents
       WHERE workspace_id = $1`,
      [workspaceId]
    );

    const finRes = await queryable.query(
      `SELECT id, product_id AS "productId", scope, type, severity, title, description, observed_evidence AS "observedEvidence", derived_conclusion AS "derivedConclusion", merchant_verified AS "merchantVerified", why_it_matters AS "whyItMatters", suggested_correction AS "suggestedCorrection", target_field AS "targetField", current_value AS "currentValue", recommended_value AS "recommendedValue", action_item_id AS "actionItemId"
       FROM findings
       WHERE workspace_id = $1`,
      [workspaceId]
    );

    const actRes = await queryable.query(
      `SELECT id, finding_id AS "findingId", product_id AS "productId", title, severity, status, verification_status AS "verificationStatus", proposed_change_json AS "proposedChangeJson", audit_log_json AS "auditLogJson"
       FROM action_items
       WHERE workspace_id = $1`,
      [workspaceId]
    );

    const variantsByProduct = new Map<string, Variant[]>();
    for (const r of varRes.rows) {
      const v: Variant = {
        id: r.id,
        sku: r.sku,
        title: r.title,
        barcode: r.barcode,
        price: r.price !== null ? parseFloat(r.price) : null,
        inventoryCount: r.inventoryCount,
        attributes: typeof r.attributesJson === 'string' ? JSON.parse(r.attributesJson) : r.attributesJson,
      };
      if (!variantsByProduct.has(r.productId)) variantsByProduct.set(r.productId, []);
      variantsByProduct.get(r.productId)!.push(v);
    }

    const offersByProduct = new Map<string, Offer[]>();
    for (const r of offRes.rows) {
      const o: Offer = {
        id: r.id,
        channel: r.channel,
        price: parseFloat(r.price),
        currency: r.currency,
        availability: r.availability,
        condition: r.condition,
        url: r.url,
        merchantId: r.merchantId,
        lastSync: r.lastSync,
      };
      if (!offersByProduct.has(r.productId)) offersByProduct.set(r.productId, []);
      offersByProduct.get(r.productId)!.push(o);
    }

    const evidenceByProduct = new Map<string, EvidenceDocument[]>();
    for (const r of eviRes.rows) {
      const e: EvidenceDocument = {
        id: r.id,
        title: r.title,
        type: r.type,
        issuer: r.issuer,
        dateVerified: r.dateVerified,
        url: r.url,
        status: r.status,
      };
      if (!evidenceByProduct.has(r.productId)) evidenceByProduct.set(r.productId, []);
      evidenceByProduct.get(r.productId)!.push(e);
    }

    const products: Product[] = prodRes.rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      brand: r.brand,
      category: r.category,
      description: r.description,
      image: r.image,
      status: r.status,
      completenessScore: r.completenessScore,
      evidenceCoverageScore: r.evidenceCoverageScore,
      externalDiscoveryStatus: r.externalDiscoveryStatus,
      attributes: typeof r.attributesJson === 'string' ? JSON.parse(r.attributesJson) : r.attributesJson,
      variants: variantsByProduct.get(r.id) || [],
      offers: offersByProduct.get(r.id) || [],
      evidenceDocuments: evidenceByProduct.get(r.id) || [],
      findingsCount: r.findingsCount,
      lastAudited: r.lastAudited,
    }));

    const findings: Finding[] = finRes.rows.map((r: any) => ({
      id: r.id,
      productId: r.productId || undefined,
      scope: r.scope,
      type: r.type,
      severity: r.severity,
      title: r.title,
      description: r.description,
      observedEvidence: r.observedEvidence,
      derivedConclusion: r.derivedConclusion,
      merchantVerified: r.merchantVerified,
      whyItMatters: r.whyItMatters,
      suggestedCorrection: r.suggestedCorrection || undefined,
      targetField: r.targetField || undefined,
      currentValue: r.currentValue || undefined,
      recommendedValue: r.recommendedValue || undefined,
      actionItemId: r.actionItemId || undefined,
    }));

    const actions: ActionItem[] = actRes.rows.map((r: any) => ({
      id: r.id,
      findingId: r.findingId,
      productId: r.productId || undefined,
      title: r.title,
      severity: r.severity,
      status: r.status,
      evidenceRequired: r.evidence_required ?? false,
      verificationStatus: r.verificationStatus,
      proposedChange: typeof r.proposedChangeJson === 'string' ? JSON.parse(r.proposedChangeJson) : r.proposedChangeJson,
      auditLog: typeof r.auditLogJson === 'string' ? JSON.parse(r.auditLogJson) : r.auditLogJson,
    }));

    return {
      products,
      variants: products.flatMap(p => p.variants || []),
      offers: products.flatMap(p => p.offers || []),
      findings,
      actions,
      evidence: products.flatMap(p => p.evidenceDocuments || []),
      storeProfile: store,
    };
  }

  private async saveCatalogRows(
    client: PoolClient,
    workspaceId: string,
    payload: StoragePayloadV1,
    storeId: string,
    authoritativeStore: StoreProfile
  ): Promise<void> {
    const authoritativeSkuCount = countCatalogSkus(payload.products);
    authoritativeStore.skuCount = authoritativeSkuCount;
    if (payload.storeProfile) {
      payload.storeProfile.skuCount = authoritativeSkuCount;
    }

    // Update store profile, preserving server-managed tier and sku_limit
    await client.query(
      `INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, tier, sku_limit, connectors_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         domain = EXCLUDED.domain,
         currency = EXCLUDED.currency,
         sku_count = EXCLUDED.sku_count,
         catalog_completeness_avg = EXCLUDED.catalog_completeness_avg,
         truth_boundary_strictness = EXCLUDED.truth_boundary_strictness,
         tier = EXCLUDED.tier,
         sku_limit = EXCLUDED.sku_limit,
         connectors_json = EXCLUDED.connectors_json,
         updated_at = NOW()`,
      [
        storeId,
        workspaceId,
        payload.storeProfile?.name || authoritativeStore.name,
        payload.storeProfile?.domain || authoritativeStore.domain,
        payload.storeProfile?.currency || authoritativeStore.currency,
        authoritativeSkuCount,
        payload.storeProfile?.catalogCompletenessAvg ?? authoritativeStore.catalogCompletenessAvg ?? 0,
        payload.storeProfile?.truthBoundaryStrictness || authoritativeStore.truthBoundaryStrictness,
        authoritativeStore.tier,
        authoritativeStore.skuLimit !== undefined ? authoritativeStore.skuLimit : null,
        JSON.stringify(payload.storeProfile?.connectors || authoritativeStore.connectors || []),
      ]
    );

    // Clean old child records for this workspace in transaction
    await client.query('DELETE FROM action_items WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM findings WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM evidence_documents WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM offers WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM variants WHERE workspace_id = $1', [workspaceId]);
    await client.query('DELETE FROM products WHERE workspace_id = $1', [workspaceId]);

    // Insert products
    for (const p of payload.products) {
      await client.query(
        `INSERT INTO products (id, workspace_id, store_id, title, brand, category, description, image, status, completeness_score, evidence_coverage_score, external_discovery_status, attributes_json, findings_count, last_audited, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, NOW(), NOW())`,
        [
          p.id,
          workspaceId,
          storeId,
          p.title,
          p.brand,
          p.category,
          p.description,
          p.image,
          p.status,
          p.completenessScore,
          p.evidenceCoverageScore,
          p.externalDiscoveryStatus,
          JSON.stringify(p.attributes || {}),
          p.findingsCount,
          p.lastAudited,
        ]
      );

      // Insert variants
      for (const v of p.variants || []) {
        await client.query(
          `INSERT INTO variants (id, workspace_id, product_id, sku, title, barcode, price, inventory_count, attributes_json, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW())`,
          [
            v.id,
            workspaceId,
            p.id,
            v.sku,
            v.title,
            v.barcode || '',
            v.price,
            v.inventoryCount ?? null,
            JSON.stringify(v.attributes || {}),
          ]
        );
      }

      // Insert offers
      for (const o of p.offers || []) {
        await client.query(
          `INSERT INTO offers (id, workspace_id, product_id, channel, price, currency, availability, condition, url, merchant_id, last_sync, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
          [
            o.id,
            workspaceId,
            p.id,
            o.channel,
            o.price,
            o.currency,
            o.availability,
            o.condition,
            o.url,
            o.merchantId,
            o.lastSync,
          ]
        );
      }

      // Insert evidence
      for (const e of p.evidenceDocuments || []) {
        await client.query(
          `INSERT INTO evidence_documents (id, workspace_id, product_id, title, type, issuer, date_verified, url, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
          [
            e.id,
            workspaceId,
            p.id,
            e.title,
            e.type,
            e.issuer,
            e.dateVerified,
            e.url || null,
            e.status,
          ]
        );
      }
    }

    // Insert findings
    for (const f of payload.findings) {
      await client.query(
        `INSERT INTO findings (id, workspace_id, store_id, product_id, scope, type, severity, title, description, observed_evidence, derived_conclusion, merchant_verified, why_it_matters, suggested_correction, target_field, current_value, recommended_value, action_item_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())`,
        [
          f.id,
          workspaceId,
          storeId,
          f.productId || null,
          f.scope,
          f.type,
          f.severity,
          f.title,
          f.description,
          f.observedEvidence,
          f.derivedConclusion,
          f.merchantVerified,
          f.whyItMatters,
          f.suggestedCorrection || null,
          f.targetField || null,
          f.currentValue || null,
          f.recommendedValue || null,
          f.actionItemId || null,
        ]
      );
    }

    // Insert action items
    for (const a of payload.actions) {
      await client.query(
        `INSERT INTO action_items (id, workspace_id, store_id, finding_id, product_id, title, severity, status, verification_status, proposed_change_json, audit_log_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, NOW(), NOW())`,
        [
          a.id,
          workspaceId,
          storeId,
          a.findingId,
          a.productId || null,
          a.title,
          a.severity,
          a.status,
          a.verificationStatus,
          JSON.stringify(a.proposedChange || {}),
          JSON.stringify(a.auditLog || []),
        ]
      );
    }
  }

  async loadWorkspaceCatalog(workspaceId: string): Promise<StoragePayloadV1 | null> {
    const store = await this.getStoreByWorkspace(workspaceId);
    if (!store) return null;
    return this.loadCatalogRows(this.pool, workspaceId, store);
  }

  async saveWorkspaceCatalog(workspaceId: string, payload: StoragePayloadV1): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const storeId = `store_${workspaceId}`;

      // 1. Consistent lock order: Acquire row-level lock on stores table
      let storeRes = await client.query<{
        id: string;
        tier: string;
        sku_limit: number | null;
        name: string;
        domain: string;
        currency: string;
        sku_count: number;
        catalog_completeness_avg: number;
        truth_boundary_strictness: string;
        connectors_json: any;
      }>(
        `SELECT id, tier, sku_limit, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json
         FROM stores
         WHERE workspace_id = $1
         FOR UPDATE`,
        [workspaceId]
      );

      if (storeRes.rows.length === 0) {
        await client.query(
          `INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 0, 0, 'standard', 'Free Audit', '[]'::jsonb, NOW(), NOW())
           ON CONFLICT (id) DO NOTHING`,
          [storeId, workspaceId, `${workspaceId} Store`, `${workspaceId}.myshopify.com`, 'USD']
        );
        storeRes = await client.query(
          `SELECT id, tier, sku_limit, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json
           FROM stores
           WHERE workspace_id = $1
           FOR UPDATE`,
          [workspaceId]
        );
      }

      const lockedRow = storeRes.rows[0] || {
        id: storeId,
        tier: 'Free Audit',
        sku_limit: null,
        name: payload.storeProfile?.name || 'Store',
        domain: payload.storeProfile?.domain || `${workspaceId}.myshopify.com`,
        currency: payload.storeProfile?.currency || 'USD',
        sku_count: 0,
        catalog_completeness_avg: 0,
        truth_boundary_strictness: 'standard',
        connectors_json: '[]',
      };
      const authoritativeStore: StoreProfile = {
        name: lockedRow.name || payload.storeProfile?.name || 'Store',
        domain: lockedRow.domain || payload.storeProfile?.domain || `${workspaceId}.myshopify.com`,
        currency: lockedRow.currency || payload.storeProfile?.currency || 'USD',
        skuCount: lockedRow.sku_count || 0,
        catalogCompletenessAvg: lockedRow.catalog_completeness_avg || 0,
        truthBoundaryStrictness: (lockedRow.truth_boundary_strictness || 'standard') as any,
        tier: (lockedRow.tier || 'Free Audit') as any,
        skuLimit: lockedRow.sku_limit !== null ? lockedRow.sku_limit : undefined,
        connectors: typeof lockedRow.connectors_json === 'string' ? JSON.parse(lockedRow.connectors_json) : (lockedRow.connectors_json || []),
      };

      // 2. Authoritative quota check inside the transaction under the row lock
      const proposedSkus = countCatalogSkus(payload.products);
      const quotaCheck = checkPlanQuota(authoritativeStore, [], proposedSkus);
      if (!quotaCheck.allowed) {
        throw new PlanQuotaExceededError(quotaCheck);
      }

      // 3. Persist rows under the lock
      await this.saveCatalogRows(client, workspaceId, payload, storeId, authoritativeStore);

      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[AIXSHOP Database] Rollback failed:', rollbackErr);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async mutateCatalogUnderLock<T>(
    workspaceId: string,
    mutator: (catalog: StoragePayloadV1, authoritativeStore: StoreProfile) => { nextCatalog: StoragePayloadV1; result: T }
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const storeId = `store_${workspaceId}`;

      // 1. Consistent lock order: Acquire row-level lock on stores table first
      let storeRes = await client.query<{
        id: string;
        tier: string;
        sku_limit: number | null;
        name: string;
        domain: string;
        currency: string;
        sku_count: number;
        catalog_completeness_avg: number;
        truth_boundary_strictness: string;
        connectors_json: any;
      }>(
        `SELECT id, tier, sku_limit, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json
         FROM stores
         WHERE workspace_id = $1
         FOR UPDATE`,
        [workspaceId]
      );

      if (storeRes.rows.length === 0) {
        throw new Error(`Workspace ${workspaceId} catalog not found`);
      }

      const lockedRow = storeRes.rows[0];
      const authoritativeStore: StoreProfile = {
        name: lockedRow.name || 'Store',
        domain: lockedRow.domain || `${workspaceId}.myshopify.com`,
        currency: lockedRow.currency || 'USD',
        skuCount: lockedRow.sku_count || 0,
        catalogCompletenessAvg: lockedRow.catalog_completeness_avg || 0,
        truthBoundaryStrictness: (lockedRow.truth_boundary_strictness || 'standard') as any,
        tier: (lockedRow.tier || 'Free Audit') as any,
        skuLimit: lockedRow.sku_limit !== null ? lockedRow.sku_limit : undefined,
        connectors: typeof lockedRow.connectors_json === 'string' ? JSON.parse(lockedRow.connectors_json) : (lockedRow.connectors_json || []),
      };

      // 2. Read latest catalog state using that same transaction client, AFTER acquiring the lock
      const catalog = await this.loadCatalogRows(client, workspaceId, authoritativeStore);
      if (!catalog) {
        throw new Error(`Workspace ${workspaceId} catalog not found`);
      }

      // 3. Apply the requested mutation to the latest authoritative state
      const { nextCatalog, result } = mutator(catalog, authoritativeStore);

      // 4. Validate quota under the lock
      const proposedSkus = countCatalogSkus(nextCatalog.products);
      const quotaCheck = checkPlanQuota(authoritativeStore, [], proposedSkus);
      if (!quotaCheck.allowed) {
        throw new PlanQuotaExceededError(quotaCheck);
      }

      // 5. Persist the updated catalog through transaction-aware helper reusing the same client
      await this.saveCatalogRows(client, workspaceId, nextCatalog, storeId, authoritativeStore);

      // 6. Commit
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[AIXSHOP Database] Rollback failed:', rollbackErr);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async approveAction(
    workspaceId: string, 
    actionId: string, 
    customApprovedValue?: string
  ): Promise<{ action: ActionItem; product?: Product }> {
    return this.mutateCatalogUnderLock(workspaceId, (catalog, authoritativeStore) => {
      const result = executeActionApproval(actionId, customApprovedValue, {
        products: catalog.products,
        findings: catalog.findings,
        actionItems: catalog.actions,
        storeProfile: catalog.storeProfile || authoritativeStore,
        isReadOnly: false,
      });

      if (!result.success) {
        throw new Error(result.message || 'Action approval failed');
      }

      const nextCatalog: StoragePayloadV1 = {
        ...catalog,
        actions: result.nextActions,
        products: result.nextProducts,
        findings: result.nextFindings,
        storeProfile: result.nextStoreProfile || catalog.storeProfile,
      };

      const updatedAction = result.nextActions.find(a => a.id === actionId);
      if (!updatedAction) throw new Error(`Action ${actionId} not found after mutation`);
      const updatedProduct = updatedAction.productId 
        ? result.nextProducts.find(p => p.id === updatedAction.productId)
        : undefined;

      return {
        nextCatalog,
        result: { action: updatedAction, product: updatedProduct },
      };
    });
  }

  async dismissAction(workspaceId: string, actionId: string): Promise<{ action: ActionItem }> {
    return this.mutateCatalogUnderLock(workspaceId, (catalog, authoritativeStore) => {
      const result = executeActionDismissal(actionId, {
        products: catalog.products,
        findings: catalog.findings,
        actionItems: catalog.actions,
        storeProfile: catalog.storeProfile || authoritativeStore,
        isReadOnly: false,
      });

      if (!result.success) {
        throw new Error(result.message || 'Action dismissal failed');
      }

      const nextCatalog: StoragePayloadV1 = {
        ...catalog,
        actions: result.nextActions,
      };

      const updatedAction = result.nextActions.find(a => a.id === actionId);
      if (!updatedAction) throw new Error(`Action ${actionId} not found`);

      return {
        nextCatalog,
        result: { action: updatedAction },
      };
    });
  }

  async recheckAction(workspaceId: string, actionId: string): Promise<{ action: ActionItem }> {
    return this.mutateCatalogUnderLock(workspaceId, (catalog, authoritativeStore) => {
      const result = executeActionRecheck(actionId, {
        products: catalog.products,
        findings: catalog.findings,
        actionItems: catalog.actions,
        storeProfile: catalog.storeProfile || authoritativeStore,
        isReadOnly: false,
      });

      if (!result.success) {
        throw new Error(result.message || 'Action recheck failed');
      }

      const nextCatalog: StoragePayloadV1 = {
        ...catalog,
        actions: result.nextActions,
        findings: result.nextFindings || catalog.findings,
      };

      const updatedAction = result.nextActions.find(a => a.id === actionId);
      if (!updatedAction) throw new Error(`Action ${actionId} not found`);

      return {
        nextCatalog,
        result: { action: updatedAction },
      };
    });
  }

  async importCatalog(
    workspaceId: string,
    candidates: any[]
  ): Promise<CatalogImportResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const storeId = `store_${workspaceId}`;

      // 1. Consistent lock order: Acquire row-level lock on stores table
      let storeRes = await client.query<{
        id: string;
        tier: string;
        sku_limit: number | null;
        name: string;
        domain: string;
        currency: string;
        sku_count: number;
        catalog_completeness_avg: number;
        truth_boundary_strictness: string;
        connectors_json: any;
      }>(
        `SELECT id, tier, sku_limit, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json
         FROM stores
         WHERE workspace_id = $1
         FOR UPDATE`,
        [workspaceId]
      );

      if (storeRes.rows.length === 0) {
        await client.query(
          `INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 0, 0, 'standard', 'Free Audit', '[]'::jsonb, NOW(), NOW())
           ON CONFLICT (id) DO NOTHING`,
          [storeId, workspaceId, `${workspaceId} Store`, `${workspaceId}.myshopify.com`, 'USD']
        );
        storeRes = await client.query(
          `SELECT id, tier, sku_limit, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json
           FROM stores
           WHERE workspace_id = $1
           FOR UPDATE`,
          [workspaceId]
        );
      }

      const lockedRow = storeRes.rows[0] || {
        id: storeId,
        tier: 'Free Audit',
        sku_limit: null,
        name: 'Store',
        domain: `${workspaceId}.myshopify.com`,
        currency: 'USD',
        sku_count: 0,
        catalog_completeness_avg: 0,
        truth_boundary_strictness: 'standard',
        connectors_json: '[]',
      };
      const authoritativeStore: StoreProfile = {
        name: lockedRow.name || 'Store',
        domain: lockedRow.domain || `${workspaceId}.myshopify.com`,
        currency: lockedRow.currency || 'USD',
        skuCount: lockedRow.sku_count || 0,
        catalogCompletenessAvg: lockedRow.catalog_completeness_avg || 0,
        truthBoundaryStrictness: (lockedRow.truth_boundary_strictness || 'standard') as any,
        tier: (lockedRow.tier || 'Free Audit') as any,
        skuLimit: lockedRow.sku_limit !== null ? lockedRow.sku_limit : undefined,
        connectors: typeof lockedRow.connectors_json === 'string' ? JSON.parse(lockedRow.connectors_json) : (lockedRow.connectors_json || []),
      };

      // 2. Load existing catalog inside the transaction on the same locked client
      const existingCatalog = await this.loadCatalogRows(client, workspaceId, authoritativeStore);

      // 3. Deduplicate and calculate additional usage under the lock
      const { additionalSkus } = calculateImportUsage(candidates, existingCatalog.products);

      // 4. Authoritative server-side quota validation under the lock
      const quotaCheck = checkPlanQuota(authoritativeStore, existingCatalog.products, additionalSkus);
      if (!quotaCheck.allowed) {
        throw new PlanQuotaExceededError(quotaCheck);
      }

      // 5. Ingest domain candidates
      const importRes = executeCatalogImport(candidates, {
        products: existingCatalog.products,
        findings: existingCatalog.findings,
        actionItems: existingCatalog.actions,
        storeProfile: authoritativeStore,
        isReadOnly: false,
      });

      if (importRes.importedCount > 0) {
        await this.saveCatalogRows(
          client,
          workspaceId,
          {
            products: importRes.nextProducts,
            variants: importRes.nextProducts.flatMap(p => p.variants || []),
            offers: existingCatalog.offers,
            findings: existingCatalog.findings,
            actions: existingCatalog.actions,
            evidence: existingCatalog.evidence,
            storeProfile: importRes.nextStoreProfile,
          },
          storeId,
          authoritativeStore
        );
      }

      await client.query('COMMIT');
      return importRes;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[AIXSHOP Database] Rollback failed:', rollbackErr);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // Billing & Subscriptions
  async getSubscriptionByWorkspace(workspaceId: string): Promise<SubscriptionRecord | null> {
    const res = await this.pool.query<any>(
      `SELECT id, workspace_id AS "workspaceId", provider, customer_id AS "customerId", subscription_id AS "subscriptionId", tier, status, current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd", cancel_at_period_end AS "cancelAtPeriodEnd", last_event_created AS "lastEventCreated", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM subscriptions
       WHERE workspace_id = $1`,
      [workspaceId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async getSubscriptionBySubscriptionId(subscriptionId: string): Promise<SubscriptionRecord | null> {
    const res = await this.pool.query<any>(
      `SELECT id, workspace_id AS "workspaceId", provider, customer_id AS "customerId", subscription_id AS "subscriptionId", tier, status, current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd", cancel_at_period_end AS "cancelAtPeriodEnd", last_event_created AS "lastEventCreated", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM subscriptions
       WHERE subscription_id = $1`,
      [subscriptionId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async saveSubscription(subscription: SubscriptionRecord): Promise<SubscriptionRecord> {
    const res = await this.pool.query<any>(
      `INSERT INTO subscriptions (id, workspace_id, provider, customer_id, subscription_id, tier, status, current_period_start, current_period_end, cancel_at_period_end, last_event_created, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
       ON CONFLICT (workspace_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         customer_id = EXCLUDED.customer_id,
         subscription_id = EXCLUDED.subscription_id,
         tier = EXCLUDED.tier,
         status = EXCLUDED.status,
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         last_event_created = EXCLUDED.last_event_created,
         updated_at = NOW()
       RETURNING id, workspace_id AS "workspaceId", provider, customer_id AS "customerId", subscription_id AS "subscriptionId", tier, status, current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd", cancel_at_period_end AS "cancelAtPeriodEnd", last_event_created AS "lastEventCreated", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        subscription.id,
        subscription.workspaceId,
        subscription.provider,
        subscription.customerId,
        subscription.subscriptionId,
        subscription.tier,
        subscription.status,
        subscription.currentPeriodStart,
        subscription.currentPeriodEnd,
        subscription.cancelAtPeriodEnd,
        subscription.lastEventCreated || 0,
      ]
    );
    return res.rows[0];
  }

  async getBillingEventById(eventId: string): Promise<BillingEventRecord | null> {
    const res = await this.pool.query<any>(
      `SELECT id, provider, event_id AS "eventId", event_type AS "eventType", idempotency_key AS "idempotencyKey",
              payload_json AS "payload", status, lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
              attempt_count AS "attemptCount", processed_at AS "processedAt", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM billing_events
       WHERE event_id = $1`,
      [eventId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      ...r,
      leaseExpiresAt: r.leaseExpiresAt ? new Date(r.leaseExpiresAt).toISOString() : null,
      processedAt: new Date(r.processedAt).toISOString(),
    };
  }

  async saveBillingEvent(event: BillingEventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO billing_events (
         id, provider, event_id, event_type, idempotency_key, payload_json, status,
         lease_owner, lease_expires_at, attempt_count, processed_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, NOW(), NOW())
       ON CONFLICT (provider, event_id) DO UPDATE SET
         status = EXCLUDED.status,
         payload_json = EXCLUDED.payload_json,
         lease_owner = EXCLUDED.lease_owner,
         lease_expires_at = EXCLUDED.lease_expires_at,
         attempt_count = EXCLUDED.attempt_count,
         processed_at = EXCLUDED.processed_at,
         updated_at = NOW()`,
      [
        event.id,
        event.provider,
        event.eventId,
        event.eventType,
        event.idempotencyKey,
        JSON.stringify(event.payload || {}),
        event.status,
        event.leaseOwner || null,
        event.leaseExpiresAt || null,
        event.attemptCount ?? 0,
        event.processedAt || new Date().toISOString(),
      ]
    );
  }

  async claimBillingEvent(
    event: BillingEventRecord,
    leaseOptions?: { leaseOwner?: string; leaseDurationMs?: number }
  ): Promise<{ claimed: boolean; event: BillingEventRecord | null; leaseOwner?: string }> {
    // Atomic insert-or-claim query with explicit durable lease ownership and expiration:
    // 1. If row does not exist, inserts with status='processing', unique lease_owner, lease_expires_at, attempt_count=1.
    // 2. If row exists and status='failed', or status='processing' whose lease_expires_at has elapsed (or legacy >5m), atomically steals/claims lease.
    // 3. Otherwise returns 0 rows so active workers never overlap.
    const leaseDurationMs = Math.max(1000, leaseOptions?.leaseDurationMs ?? 5 * 60 * 1000);
    const leaseOwner = leaseOptions?.leaseOwner || `worker_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const res = await this.pool.query<any>(
      `INSERT INTO billing_events (
         id, provider, event_id, event_type, idempotency_key, payload_json, status,
         lease_owner, lease_expires_at, attempt_count, processed_at, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'processing', $7, NOW() + ($8 * INTERVAL '1 millisecond'), 1, NOW(), NOW(), NOW())
       ON CONFLICT (provider, event_id) DO UPDATE SET
         status = 'processing',
         lease_owner = EXCLUDED.lease_owner,
         lease_expires_at = NOW() + ($8 * INTERVAL '1 millisecond'),
         attempt_count = COALESCE(billing_events.attempt_count, 0) + 1,
         payload_json = CASE WHEN EXCLUDED.payload_json <> '{}'::jsonb THEN EXCLUDED.payload_json ELSE billing_events.payload_json END,
         processed_at = NOW(),
         updated_at = NOW()
       WHERE billing_events.status = 'failed'
          OR (
            billing_events.status = 'processing' AND (
              (billing_events.lease_expires_at IS NOT NULL AND billing_events.lease_expires_at < NOW())
              OR (billing_events.lease_expires_at IS NULL AND billing_events.processed_at < NOW() - INTERVAL '5 minutes')
            )
          )
       RETURNING id, provider, event_id AS "eventId", event_type AS "eventType", idempotency_key AS "idempotencyKey",
                 payload_json AS "payload", status, lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
                 attempt_count AS "attemptCount", processed_at AS "processedAt"`,
      [
        event.id,
        event.provider,
        event.eventId,
        event.eventType,
        event.idempotencyKey,
        JSON.stringify(event.payload || {}),
        leaseOwner,
        leaseDurationMs,
      ]
    );

    if (res.rows.length > 0) {
      const row = res.rows[0];
      return {
        claimed: true,
        leaseOwner,
        event: {
          ...row,
          leaseExpiresAt: row.leaseExpiresAt ? new Date(row.leaseExpiresAt).toISOString() : null,
          processedAt: new Date(row.processedAt).toISOString(),
        },
      };
    }

    const existing = await this.getBillingEventById(event.eventId);
    return { claimed: false, event: existing };
  }

  async renewBillingEventLease(
    eventId: string,
    leaseOwner: string,
    extendMs: number = 5 * 60 * 1000
  ): Promise<boolean> {
    const safeExtendMs = Math.max(1000, extendMs);
    const res = await this.pool.query<{ id: string }>(
      `UPDATE billing_events
       SET lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE event_id = $1
         AND lease_owner = $2
         AND status = 'processing'
         AND (lease_expires_at IS NULL OR lease_expires_at >= NOW())
       RETURNING id`,
      [eventId, leaseOwner, safeExtendMs]
    );
    return (res.rowCount || 0) > 0;
  }

  async updateBillingEventStatus(
    eventId: string,
    status: 'processing' | 'processed' | 'failed' | 'ignored',
    payload?: any,
    leaseOwner?: string
  ): Promise<void> {
    const params: any[] = [eventId, status];
    const setClauses = ['status = $2', 'updated_at = NOW()'];
    if (status !== 'processing') {
      setClauses.push('lease_expires_at = NULL');
    }
    if (payload !== undefined) {
      params.push(JSON.stringify(payload));
      setClauses.push(`payload_json = $${params.length}::jsonb`);
    }

    let whereClause = 'WHERE event_id = $1';
    if (leaseOwner) {
      params.push(leaseOwner);
      whereClause += ` AND lease_owner = $${params.length} AND status = 'processing'`;
    }

    const res = await this.pool.query(
      `UPDATE billing_events
       SET ${setClauses.join(', ')}
       ${whereClause}`,
      params
    );

    if (leaseOwner && res.rowCount === 0) {
      throw new Error(`Billing lease ownership lost for event ${eventId}: stale worker "${leaseOwner}" rejected.`);
    }
  }

  async applyBillingTransition(params: {
    eventId: string;
    subscription: SubscriptionRecord;
    storeProfileUpdate?: { tier: PlanTier; skuLimit?: number };
    markProcessed?: boolean;
    leaseOwner?: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 0. Lock and verify billing event lease ownership BEFORE applying entitlement changes
      if (params.leaseOwner) {
        const lockRes = await client.query<{ status: string; lease_owner: string | null }>(
          `SELECT status, lease_owner
           FROM billing_events
           WHERE event_id = $1
           FOR UPDATE`,
          [params.eventId]
        );
        const evtRow = lockRes.rows[0];
        if (!evtRow || evtRow.status !== 'processing' || evtRow.lease_owner !== params.leaseOwner) {
          throw new Error(`Billing lease ownership lost for event ${params.eventId}: stale worker "${params.leaseOwner}" rejected.`);
        }
      }

      // 1. Upsert subscription record
      await client.query(
        `INSERT INTO subscriptions (id, workspace_id, provider, customer_id, subscription_id, tier, status, current_period_start, current_period_end, cancel_at_period_end, last_event_created, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
         ON CONFLICT (workspace_id) DO UPDATE SET
           provider = EXCLUDED.provider,
           customer_id = EXCLUDED.customer_id,
           subscription_id = EXCLUDED.subscription_id,
           tier = EXCLUDED.tier,
           status = EXCLUDED.status,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end = EXCLUDED.current_period_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           last_event_created = EXCLUDED.last_event_created,
           updated_at = NOW()`,
        [
          params.subscription.id,
          params.subscription.workspaceId,
          params.subscription.provider,
          params.subscription.customerId,
          params.subscription.subscriptionId,
          params.subscription.tier,
          params.subscription.status,
          params.subscription.currentPeriodStart,
          params.subscription.currentPeriodEnd,
          params.subscription.cancelAtPeriodEnd,
          params.subscription.lastEventCreated || 0,
        ]
      );

      // 2. Update store profile if requested
      if (params.storeProfileUpdate) {
        await client.query(
          `UPDATE stores
           SET tier = $2,
               sku_limit = $3,
               updated_at = NOW()
           WHERE workspace_id = $1`,
          [
            params.subscription.workspaceId,
            params.storeProfileUpdate.tier,
            params.storeProfileUpdate.skuLimit !== undefined ? params.storeProfileUpdate.skuLimit : null,
          ]
        );
      }

      // 3. Mark billing event processed strictly by lease owner if provided
      if (params.markProcessed !== false) {
        const updateQuery = params.leaseOwner
          ? `UPDATE billing_events
             SET status = 'processed',
                 lease_expires_at = NULL,
                 processed_at = NOW(),
                 updated_at = NOW()
             WHERE event_id = $1 AND lease_owner = $2 AND status = 'processing'`
          : `UPDATE billing_events
             SET status = 'processed',
                 lease_expires_at = NULL,
                 processed_at = NOW(),
                 updated_at = NOW()
             WHERE event_id = $1`;
        const updateRes = await client.query(
          updateQuery,
          params.leaseOwner ? [params.eventId, params.leaseOwner] : [params.eventId]
        );
        if (params.leaseOwner && updateRes.rowCount === 0) {
          throw new Error(`Billing lease ownership lost during commit for event ${params.eventId}.`);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // Catalog Audit Runs
  async createAuditRun(data: CreateAuditRunData): Promise<AuditRunRecord> {
    const query = `
      INSERT INTO audit_runs (id, workspace_id, status, products_evaluated, rules_evaluated, findings_count, summary_json, metadata_json, started_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, NOW(), NOW())
      RETURNING id, workspace_id AS "workspaceId", status, products_evaluated AS "productsEvaluated", rules_evaluated AS "rulesEvaluated", findings_count AS "findingsCount", summary_json AS "summaryJson", metadata_json AS "metadataJson", error_message AS "errorMessage", started_at AS "startedAt", completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const res = await this.pool.query(query, [
      data.id,
      data.workspaceId,
      data.status,
      data.productsEvaluated || 0,
      data.rulesEvaluated || 0,
      data.findingsCount || 0,
      JSON.stringify(data.summary || {}),
      JSON.stringify(data.metadata || {}),
      data.startedAt || new Date().toISOString(),
    ]);
    const r = res.rows[0];
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      status: r.status,
      productsEvaluated: r.productsEvaluated,
      rulesEvaluated: r.rulesEvaluated,
      findingsCount: r.findingsCount,
      summary: typeof r.summaryJson === 'string' ? JSON.parse(r.summaryJson) : r.summaryJson,
      metadata: typeof r.metadataJson === 'string' ? JSON.parse(r.metadataJson) : r.metadataJson,
      errorMessage: r.errorMessage,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async updateAuditRun(id: string, updates: UpdateAuditRunData): Promise<AuditRunRecord> {
    const fields: string[] = ['updated_at = NOW()'];
    const values: any[] = [id];
    let idx = 2;

    if (updates.status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(updates.status);
    }
    if (updates.productsEvaluated !== undefined) {
      fields.push(`products_evaluated = $${idx++}`);
      values.push(updates.productsEvaluated);
    }
    if (updates.rulesEvaluated !== undefined) {
      fields.push(`rules_evaluated = $${idx++}`);
      values.push(updates.rulesEvaluated);
    }
    if (updates.findingsCount !== undefined) {
      fields.push(`findings_count = $${idx++}`);
      values.push(updates.findingsCount);
    }
    if (updates.summary !== undefined) {
      fields.push(`summary_json = $${idx++}::jsonb`);
      values.push(JSON.stringify(updates.summary));
    }
    if (updates.metadata !== undefined) {
      fields.push(`metadata_json = $${idx++}::jsonb`);
      values.push(JSON.stringify(updates.metadata));
    }
    if (updates.errorMessage !== undefined) {
      fields.push(`error_message = $${idx++}`);
      values.push(updates.errorMessage);
    }
    if (updates.completedAt !== undefined) {
      fields.push(`completed_at = $${idx++}`);
      values.push(updates.completedAt);
    }

    const query = `
      UPDATE audit_runs
      SET ${fields.join(', ')}
      WHERE id = $1
      RETURNING id, workspace_id AS "workspaceId", status, products_evaluated AS "productsEvaluated", rules_evaluated AS "rulesEvaluated", findings_count AS "findingsCount", summary_json AS "summaryJson", metadata_json AS "metadataJson", error_message AS "errorMessage", started_at AS "startedAt", completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const res = await this.pool.query(query, values);
    if (!res.rows[0]) throw new Error(`Audit run ${id} not found`);
    const r = res.rows[0];
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      status: r.status,
      productsEvaluated: r.productsEvaluated,
      rulesEvaluated: r.rulesEvaluated,
      findingsCount: r.findingsCount,
      summary: typeof r.summaryJson === 'string' ? JSON.parse(r.summaryJson) : r.summaryJson,
      metadata: typeof r.metadataJson === 'string' ? JSON.parse(r.metadataJson) : r.metadataJson,
      errorMessage: r.errorMessage,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async getAuditRunById(id: string, workspaceId: string): Promise<AuditRunRecord | null> {
    const query = `
      SELECT id, workspace_id AS "workspaceId", status, products_evaluated AS "productsEvaluated", rules_evaluated AS "rulesEvaluated", findings_count AS "findingsCount", summary_json AS "summaryJson", metadata_json AS "metadataJson", error_message AS "errorMessage", started_at AS "startedAt", completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM audit_runs
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1
    `;
    const res = await this.pool.query(query, [id, workspaceId]);
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      status: r.status,
      productsEvaluated: r.productsEvaluated,
      rulesEvaluated: r.rulesEvaluated,
      findingsCount: r.findingsCount,
      summary: typeof r.summaryJson === 'string' ? JSON.parse(r.summaryJson) : r.summaryJson,
      metadata: typeof r.metadataJson === 'string' ? JSON.parse(r.metadataJson) : r.metadataJson,
      errorMessage: r.errorMessage,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async getLatestAuditRunByWorkspace(workspaceId: string): Promise<AuditRunRecord | null> {
    const query = `
      SELECT id, workspace_id AS "workspaceId", status, products_evaluated AS "productsEvaluated", rules_evaluated AS "rulesEvaluated", findings_count AS "findingsCount", summary_json AS "summaryJson", metadata_json AS "metadataJson", error_message AS "errorMessage", started_at AS "startedAt", completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM audit_runs
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const res = await this.pool.query(query, [workspaceId]);
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      status: r.status,
      productsEvaluated: r.productsEvaluated,
      rulesEvaluated: r.rulesEvaluated,
      findingsCount: r.findingsCount,
      summary: typeof r.summaryJson === 'string' ? JSON.parse(r.summaryJson) : r.summaryJson,
      metadata: typeof r.metadataJson === 'string' ? JSON.parse(r.metadataJson) : r.metadataJson,
      errorMessage: r.errorMessage,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async executeWorkspaceAudit(workspaceId: string): Promise<{ auditRun: AuditRunRecord; catalog: StoragePayloadV1 }> {
    const runId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    let auditRun = await this.createAuditRun({
      id: runId,
      workspaceId,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const storeId = `store_${workspaceId}`;

      // Acquire exclusive row-level lock on store
      const storeRes = await client.query<{
        id: string;
        name: string;
        domain: string;
        currency: string;
        sku_count: number;
        sku_limit: number | null;
        catalog_completeness_avg: number;
        truth_boundary_strictness: 'strict' | 'standard' | 'relaxed';
        tier: string;
        connectors_json: any;
      }>(
        `SELECT id, name, domain, currency, sku_count, sku_limit, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json
         FROM stores
         WHERE workspace_id = $1
         FOR UPDATE`,
        [workspaceId]
      );

      if (!storeRes.rows[0]) {
        throw new Error(`Store for workspace ${workspaceId} not found`);
      }

      const rawStore = storeRes.rows[0];
      const authoritativeStore: StoreProfile = {
        name: rawStore.name,
        domain: rawStore.domain,
        currency: rawStore.currency,
        skuCount: rawStore.sku_count,
        skuLimit: (typeof rawStore.sku_limit === 'number' && !isNaN(rawStore.sku_limit)) ? rawStore.sku_limit : undefined,
        tier: rawStore.tier,
        connectors: typeof rawStore.connectors_json === 'string' ? JSON.parse(rawStore.connectors_json) : rawStore.connectors_json,
        catalogCompletenessAvg: rawStore.catalog_completeness_avg,
        truthBoundaryStrictness: rawStore.truth_boundary_strictness,
      };

      const catalog = await this.loadCatalogRows(client, workspaceId, authoritativeStore);

      // Execute domain rules on real catalog data
      const auditResult = executeCatalogAudit(catalog.products, catalog.storeProfile || authoritativeStore, catalog.actions);

      // Construct next catalog state
      const nextCatalog: StoragePayloadV1 = {
        ...catalog,
        products: auditResult.updatedProducts,
        findings: auditResult.findings,
        actions: auditResult.actionItems,
        storeProfile: auditResult.updatedStoreProfile,
      };

      // Save catalog rows atomically within this transaction
      await this.saveCatalogRows(client, workspaceId, nextCatalog, storeId, auditResult.updatedStoreProfile);

      // Workstream B: Persist immutable historical snapshots in PostgreSQL transaction
      // 1. audit_run_findings
      for (const f of auditResult.findings) {
        await client.query(
          `INSERT INTO audit_run_findings (
            id, audit_run_id, workspace_id, original_finding_id, scope, product_id, product_title,
            finding_type, severity, title, description, observed_evidence, derived_conclusion,
            merchant_verified, why_it_matters, suggested_correction, target_field, current_value,
            recommended_value, action_item_id, rule_code, snapshot_created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW())`,
          [
            `hfind_${runId}_${f.id}`,
            runId,
            workspaceId,
            f.id,
            f.scope,
            f.productId || null,
            f.productTitle || null,
            f.type,
            f.severity,
            f.title,
            f.description,
            f.observedEvidence,
            f.derivedConclusion,
            f.merchantVerified,
            f.whyItMatters,
            f.suggestedCorrection || null,
            f.targetField || null,
            f.currentValue || null,
            f.recommendedValue || null,
            f.actionItemId || null,
            f.ruleCode || null,
          ]
        );
      }

      // 2. audit_run_evidence (preserve product association where evidence belongs to a product)
      const allEvidenceWithProduct: Array<{ evidence: EvidenceDocument; productId: string | null }> = [];
      if (catalog.evidence) {
        for (const e of catalog.evidence) {
          allEvidenceWithProduct.push({ evidence: e, productId: null });
        }
      }
      for (const p of catalog.products) {
        if (p.evidenceDocuments && p.evidenceDocuments.length > 0) {
          for (const e of p.evidenceDocuments) {
            allEvidenceWithProduct.push({ evidence: e, productId: p.id });
          }
        }
      }
      const evidenceMap = new Map<string, { evidence: EvidenceDocument; productId: string | null }>();
      for (const item of allEvidenceWithProduct) {
        if (item.evidence.id) {
          const existing = evidenceMap.get(item.evidence.id);
          if (!existing || (!existing.productId && item.productId)) {
            evidenceMap.set(item.evidence.id, item);
          }
        }
      }

      for (const { evidence: e, productId } of evidenceMap.values()) {
        await client.query(
          `INSERT INTO audit_run_evidence (
            id, audit_run_id, workspace_id, original_evidence_id, product_id, title,
            evidence_type, issuer, date_verified, url, status, source_type, metadata_json, snapshot_created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NOW())`,
          [
            `hevid_${runId}_${e.id}`,
            runId,
            workspaceId,
            e.id,
            productId || null,
            e.title,
            e.type,
            e.issuer,
            e.dateVerified,
            e.url || null,
            e.status || 'unverified',
            'catalog_evidence',
            JSON.stringify({}),
          ]
        );
      }

      // 3. audit_run_products
      for (const p of auditResult.updatedProducts) {
        await client.query(
          `INSERT INTO audit_run_products (
            id, audit_run_id, workspace_id, product_id, title, brand, category,
            description, image, completeness_score, attributes_json, variants_json, offers_json,
            findings_count, snapshot_created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, NOW())`,
          [
            `hprod_${runId}_${p.id}`,
            runId,
            workspaceId,
            p.id,
            p.title,
            p.brand,
            p.category,
            p.description,
            p.image,
            p.completenessScore,
            JSON.stringify(p.attributes || {}),
            JSON.stringify(p.variants || []),
            JSON.stringify(p.offers || []),
            p.findingsCount,
          ]
        );
      }

      // 4. audit_run_manifests (durable manifest record of snapshot completion)
      await client.query(
        `INSERT INTO audit_run_manifests (
          audit_run_id, workspace_id, status, products_count, findings_count, evidence_count, created_at, updated_at
        ) VALUES ($1, $2, 'COMPLETED', $3, $4, $5, NOW(), NOW())
        ON CONFLICT (audit_run_id) DO UPDATE SET
          status = 'COMPLETED',
          products_count = EXCLUDED.products_count,
          findings_count = EXCLUDED.findings_count,
          evidence_count = EXCLUDED.evidence_count,
          updated_at = NOW()`,
        [
          runId,
          workspaceId,
          auditResult.updatedProducts.length,
          auditResult.findings.length,
          evidenceMap.size,
        ]
      );

      // Mark audit run COMPLETED in database ONLY AFTER all historical snapshots are written
      await client.query(
        `UPDATE audit_runs
         SET status = 'COMPLETED',
             products_evaluated = $2,
             rules_evaluated = $3,
             findings_count = $4,
             summary_json = $5::jsonb,
             metadata_json = $6::jsonb,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [
          runId,
          auditResult.summary.totalProducts,
          auditResult.summary.rulesEvaluated,
          auditResult.summary.totalFindingsCount,
          JSON.stringify(auditResult.summary),
          JSON.stringify({
            rules: Object.keys(auditResult.summary.ruleBreakdown),
            completedAt: new Date().toISOString(),
            snapshotAvailable: true,
          }),
        ]
      );

      await client.query('COMMIT');

      auditRun = (await this.getAuditRunById(runId, workspaceId))!;

      return {
        auditRun,
        catalog: nextCatalog,
      };
    } catch (err: any) {
      await client.query('ROLLBACK');
      try {
        await this.updateAuditRun(runId, {
          status: 'FAILED',
          errorMessage: err?.message || 'Catalog audit execution failed',
          completedAt: new Date().toISOString(),
        });
      } catch {
        // preserve primary error
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getAuditRunsHistory(
    workspaceId: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{ items: Array<AuditRunRecord & { snapshotAvailable: boolean }>; nextCursor: string | null; totalCount: number }> {
    const limit = Math.min(Math.max(options?.limit || 20, 1), 100);

    // Get total count of runs for workspace
    const countRes = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM audit_runs WHERE workspace_id = $1',
      [workspaceId]
    );
    const totalCount = parseInt(countRes.rows[0]?.count || '0', 10);

    let query = `
      SELECT 
        ar.id,
        ar.workspace_id AS "workspaceId",
        ar.status,
        ar.products_evaluated AS "productsEvaluated",
        ar.rules_evaluated AS "rulesEvaluated",
        ar.findings_count AS "findingsCount",
        ar.summary_json AS "summaryJson",
        ar.metadata_json AS "metadataJson",
        ar.error_message AS "errorMessage",
        ar.started_at AS "startedAt",
        ar.completed_at AS "completedAt",
        ar.created_at AS "createdAt",
        ar.updated_at AS "updatedAt",
        (
          EXISTS (SELECT 1 FROM audit_run_manifests arm WHERE arm.audit_run_id = ar.id LIMIT 1)
          OR (ar.metadata_json->>'snapshotAvailable')::boolean = true
        ) AS "snapshotAvailable"
      FROM audit_runs ar
      WHERE ar.workspace_id = $1
    `;
    const params: any[] = [workspaceId];

    if (options?.cursor) {
      const cursorRes = await this.pool.query<{ created_at: Date }>(
        'SELECT created_at FROM audit_runs WHERE id = $1 AND workspace_id = $2',
        [options.cursor, workspaceId]
      );
      if (cursorRes.rows[0]) {
        params.push(cursorRes.rows[0].created_at);
        query += ` AND ar.created_at < $${params.length}`;
      }
    }

    params.push(limit + 1);
    query += ` ORDER BY ar.created_at DESC LIMIT $${params.length}`;

    const res = await this.pool.query(query, params);
    const hasNext = res.rows.length > limit;
    const rows = hasNext ? res.rows.slice(0, limit) : res.rows;
    const nextCursor = hasNext && rows.length > 0 ? rows[rows.length - 1].id : null;

    const items = rows.map(r => ({
      id: r.id,
      workspaceId: r.workspaceId,
      status: r.status,
      productsEvaluated: r.productsEvaluated,
      rulesEvaluated: r.rulesEvaluated,
      findingsCount: r.findingsCount,
      summary: typeof r.summaryJson === 'string' ? JSON.parse(r.summaryJson) : r.summaryJson,
      metadata: typeof r.metadataJson === 'string' ? JSON.parse(r.metadataJson) : r.metadataJson,
      errorMessage: r.errorMessage,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      snapshotAvailable: Boolean(r.snapshotAvailable),
    }));

    return {
      items,
      nextCursor,
      totalCount,
    };
  }

  async getHistoricalAuditSnapshot(
    workspaceId: string,
    auditRunId: string
  ): Promise<import('../../domain/audit/historicalTypes').HistoricalAuditSnapshot | null> {
    const auditRun = await this.getAuditRunById(auditRunId, workspaceId);
    if (!auditRun) return null;

    // Check if snapshot manifest or completion record exists
    const manifestRes = await this.pool.query<{ status: string }>(
      'SELECT status FROM audit_run_manifests WHERE audit_run_id = $1 AND workspace_id = $2',
      [auditRunId, workspaceId]
    );
    const hasManifest = manifestRes.rows.length > 0 || (auditRun.metadata && auditRun.metadata.snapshotAvailable === true);

    const findingsRes = await this.pool.query<any>(
      `SELECT 
        id, audit_run_id AS "auditRunId", workspace_id AS "workspaceId",
        original_finding_id AS "originalFindingId", scope, product_id AS "productId",
        product_title AS "productTitle", finding_type AS "findingType", severity,
        title, description, observed_evidence AS "observedEvidence",
        derived_conclusion AS "derivedConclusion", merchant_verified AS "merchantVerified",
        why_it_matters AS "whyItMatters", suggested_correction AS "suggestedCorrection",
        target_field AS "targetField", current_value AS "currentValue",
        recommended_value AS "recommendedValue", action_item_id AS "actionItemId",
        rule_code AS "ruleCode", snapshot_created_at AS "snapshotCreatedAt"
       FROM audit_run_findings
       WHERE audit_run_id = $1 AND workspace_id = $2
       ORDER BY snapshot_created_at ASC`,
      [auditRunId, workspaceId]
    );

    const productsRes = await this.pool.query<any>(
      `SELECT 
        id, audit_run_id AS "auditRunId", workspace_id AS "workspaceId",
        product_id AS "productId", title, brand, category, description, image,
        completeness_score AS "completenessScore", attributes_json AS "attributes",
        variants_json AS "variants", offers_json AS "offers",
        findings_count AS "findingsCount", snapshot_created_at AS "snapshotCreatedAt"
       FROM audit_run_products
       WHERE audit_run_id = $1 AND workspace_id = $2
       ORDER BY snapshot_created_at ASC`,
      [auditRunId, workspaceId]
    );

    if (!hasManifest && findingsRes.rows.length === 0 && productsRes.rows.length === 0) {
      // Legacy audit run without snapshots
      return {
        auditRun,
        findings: [],
        evidence: [],
        products: [],
        snapshotAvailable: false,
        message: 'Historical snapshot unavailable — this audit was created before Audit History & Evidence was implemented.',
      };
    }

    const evidenceRes = await this.pool.query<any>(
      `SELECT 
        id, audit_run_id AS "auditRunId", workspace_id AS "workspaceId",
        original_evidence_id AS "originalEvidenceId", product_id AS "productId",
        title, evidence_type AS "evidenceType", issuer, date_verified AS "dateVerified",
        url, status, source_type AS "sourceType", metadata_json AS "metadata",
        snapshot_created_at AS "snapshotCreatedAt"
       FROM audit_run_evidence
       WHERE audit_run_id = $1 AND workspace_id = $2
       ORDER BY snapshot_created_at ASC`,
      [auditRunId, workspaceId]
    );

    const findings: import('../../domain/audit/historicalTypes').HistoricalFindingRecord[] = findingsRes.rows.map(r => ({
      ...r,
      merchantVerified: Boolean(r.merchantVerified),
    }));

    const evidence: import('../../domain/audit/historicalTypes').HistoricalEvidenceRecord[] = evidenceRes.rows.map(r => ({
      ...r,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata || {},
    }));

    const products: import('../../domain/audit/historicalTypes').HistoricalProductRecord[] = productsRes.rows.map(r => ({
      ...r,
      attributes: typeof r.attributes === 'string' ? JSON.parse(r.attributes) : r.attributes || {},
      variants: typeof r.variants === 'string' ? JSON.parse(r.variants) : r.variants || [],
      offers: typeof r.offers === 'string' ? JSON.parse(r.offers) : r.offers || [],
    }));

    return {
      auditRun,
      findings,
      evidence,
      products,
      snapshotAvailable: true,
    };
  }

  async compareHistoricalAudits(
    workspaceId: string,
    baseAuditId: string,
    targetAuditId: string
  ): Promise<import('../../domain/audit/historicalTypes').AuditComparisonResult | null> {
    const baseSnapshot = await this.getHistoricalAuditSnapshot(workspaceId, baseAuditId);
    const targetSnapshot = await this.getHistoricalAuditSnapshot(workspaceId, targetAuditId);

    if (!baseSnapshot || !targetSnapshot) return null;

    const { compareHistoricalAudits } = await import('../../domain/audit/comparisonService');
    return compareHistoricalAudits(
      baseSnapshot.auditRun,
      baseSnapshot.findings,
      targetSnapshot.auditRun,
      targetSnapshot.findings
    );
  }

  // ==========================================
  // Workstream C: Shopify Integration Methods
  // ==========================================

  private mapShopifyConnectionRow(r: any): import('../shopify/types').ShopifyConnectionRecord {
    return {
      ...r,
      tokenExpiresAt: r.tokenExpiresAt ? new Date(r.tokenExpiresAt).toISOString() : null,
      refreshTokenExpiresAt: r.refreshTokenExpiresAt ? new Date(r.refreshTokenExpiresAt).toISOString() : null,
      lastRefreshedAt: r.lastRefreshedAt ? new Date(r.lastRefreshedAt).toISOString() : null,
      webhookSubscriptions: Array.isArray(r.webhookSubscriptions)
        ? r.webhookSubscriptions
        : (typeof r.webhookSubscriptions === 'string' ? JSON.parse(r.webhookSubscriptions) : []),
      webhookLastVerifiedAt: r.webhookLastVerifiedAt ? new Date(r.webhookLastVerifiedAt).toISOString() : null,
      webhookVerificationStatus: r.webhookVerificationStatus || 'not_configured',
      webhookVerificationDetails: typeof r.webhookVerificationDetails === 'string'
        ? JSON.parse(r.webhookVerificationDetails)
        : (r.webhookVerificationDetails || {}),
      installedAt: new Date(r.installedAt).toISOString(),
      lastVerifiedAt: new Date(r.lastVerifiedAt).toISOString(),
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  }

  async getShopifyConnection(workspaceId: string): Promise<import('../shopify/types').ShopifyConnectionRecord | null> {
    const res = await this.pool.query<any>(
      `SELECT 
        id, workspace_id AS "workspaceId", shop_domain AS "shopDomain",
        access_token_encrypted AS "accessTokenEncrypted", refresh_token_encrypted AS "refreshTokenEncrypted",
        token_expires_at AS "tokenExpiresAt", refresh_token_expires_at AS "refreshTokenExpiresAt",
        last_refreshed_at AS "lastRefreshedAt", webhook_subscriptions_json AS "webhookSubscriptions",
        webhook_last_verified_at AS "webhookLastVerifiedAt",
        webhook_verification_status AS "webhookVerificationStatus",
        webhook_verification_details AS "webhookVerificationDetails",
        granted_scopes AS "grantedScopes", key_version AS "keyVersion", status, installed_at AS "installedAt",
        last_verified_at AS "lastVerifiedAt", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM shopify_connections
       WHERE workspace_id = $1`,
      [workspaceId]
    );

    if (res.rows.length === 0) return null;
    return this.mapShopifyConnectionRow(res.rows[0]);
  }

  async getShopifyConnectionByShop(shopDomain: string): Promise<import('../shopify/types').ShopifyConnectionRecord | null> {
    const normShop = shopDomain.trim().toLowerCase();
    const res = await this.pool.query<any>(
      `SELECT 
        id, workspace_id AS "workspaceId", shop_domain AS "shopDomain",
        access_token_encrypted AS "accessTokenEncrypted", refresh_token_encrypted AS "refreshTokenEncrypted",
        token_expires_at AS "tokenExpiresAt", refresh_token_expires_at AS "refreshTokenExpiresAt",
        last_refreshed_at AS "lastRefreshedAt", webhook_subscriptions_json AS "webhookSubscriptions",
        webhook_last_verified_at AS "webhookLastVerifiedAt",
        webhook_verification_status AS "webhookVerificationStatus",
        webhook_verification_details AS "webhookVerificationDetails",
        granted_scopes AS "grantedScopes", key_version AS "keyVersion", status, installed_at AS "installedAt",
        last_verified_at AS "lastVerifiedAt", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM shopify_connections
       WHERE LOWER(shop_domain) = $1`,
      [normShop]
    );

    if (res.rows.length === 0) return null;
    return this.mapShopifyConnectionRow(res.rows[0]);
  }

  async saveShopifyConnection(conn: import('../shopify/types').ShopifyConnectionRecord): Promise<import('../shopify/types').ShopifyConnectionRecord> {
    await this.pool.query(
      `INSERT INTO shopify_connections (
        id, workspace_id, shop_domain, access_token_encrypted, refresh_token_encrypted,
        token_expires_at, refresh_token_expires_at, last_refreshed_at, webhook_subscriptions_json,
        webhook_last_verified_at, webhook_verification_status, webhook_verification_details,
        granted_scopes, key_version, status, installed_at,
        last_verified_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, NOW(), NOW())
      ON CONFLICT (workspace_id) DO UPDATE SET
        shop_domain = EXCLUDED.shop_domain,
        access_token_encrypted = EXCLUDED.access_token_encrypted,
        refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
        token_expires_at = EXCLUDED.token_expires_at,
        refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
        last_refreshed_at = EXCLUDED.last_refreshed_at,
        webhook_subscriptions_json = EXCLUDED.webhook_subscriptions_json,
        webhook_last_verified_at = EXCLUDED.webhook_last_verified_at,
        webhook_verification_status = EXCLUDED.webhook_verification_status,
        webhook_verification_details = EXCLUDED.webhook_verification_details,
        granted_scopes = EXCLUDED.granted_scopes,
        key_version = EXCLUDED.key_version,
        status = EXCLUDED.status,
        last_verified_at = EXCLUDED.last_verified_at,
        updated_at = NOW()`,
      [
        conn.id,
        conn.workspaceId,
        conn.shopDomain,
        conn.accessTokenEncrypted,
        conn.refreshTokenEncrypted || null,
        conn.tokenExpiresAt || null,
        conn.refreshTokenExpiresAt || null,
        conn.lastRefreshedAt || null,
        JSON.stringify(conn.webhookSubscriptions || []),
        conn.webhookLastVerifiedAt || null,
        conn.webhookVerificationStatus || 'not_configured',
        JSON.stringify(conn.webhookVerificationDetails || {}),
        conn.grantedScopes,
        conn.keyVersion,
        conn.status,
        conn.installedAt,
        conn.lastVerifiedAt,
      ]
    );

    return (await this.getShopifyConnection(conn.workspaceId))!;
  }

  async deleteShopifyConnection(workspaceId: string): Promise<void> {
    await this.pool.query(
      `UPDATE shopify_connections
       SET status = 'disconnected',
           access_token_encrypted = '',
           refresh_token_encrypted = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1`,
      [workspaceId]
    );
  }

  async saveShopifyOAuthState(state: { id: string; workspaceId: string; shopDomain: string; expiresAt: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO shopify_oauth_states (id, workspace_id, shop_domain, expires_at, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET
         shop_domain = EXCLUDED.shop_domain,
         expires_at = EXCLUDED.expires_at`,
      [state.id, state.workspaceId, state.shopDomain, state.expiresAt]
    );
  }

  async getAndConsumeShopifyOAuthState(stateId: string): Promise<{ id: string; workspaceId: string; shopDomain: string; expiresAt: string } | null> {
    const res = await this.pool.query<any>(
      `DELETE FROM shopify_oauth_states
       WHERE id = $1
       RETURNING id, workspace_id AS "workspaceId", shop_domain AS "shopDomain", expires_at AS "expiresAt"`,
      [stateId]
    );

    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      shopDomain: r.shopDomain,
      expiresAt: new Date(r.expiresAt).toISOString(),
    };
  }

  private mapShopifySyncRunRow(r: any): import('../shopify/types').ShopifySyncRunRecord {
    const parseJson = (v: any, fallback: any) =>
      v === null || v === undefined ? fallback : typeof v === 'string' ? JSON.parse(v) : v;

    return {
      ...r,
      parentSyncRunId: r.parentSyncRunId || null,
      attemptNumber: typeof r.attemptNumber === 'number' ? r.attemptNumber : Number(r.attemptNumber || 1),
      variantCompletenessStatus: r.variantCompletenessStatus || 'complete',
      variantCompleteness: parseJson(r.variantCompleteness, undefined),
      paginationMetadata: parseJson(r.paginationMetadata, undefined),
      startedAt: new Date(r.startedAt).toISOString(),
      completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  }

  async createShopifySyncRun(run: import('../shopify/types').ShopifySyncRunRecord): Promise<import('../shopify/types').ShopifySyncRunRecord> {
    const res = await this.pool.query<any>(
      `INSERT INTO shopify_sync_runs (
        id, workspace_id, shop_domain, status, products_discovered, products_imported,
        variants_imported, excluded_by_plan, cursor_resumed, error_message,
        parent_sync_run_id, attempt_number, variant_completeness_status,
        variant_completeness_json, pagination_metadata_json,
        started_at, completed_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, $17, NOW(), NOW())
      RETURNING
        id, workspace_id AS "workspaceId", shop_domain AS "shopDomain", status,
        products_discovered AS "productsDiscovered", products_imported AS "productsImported",
        variants_imported AS "variantsImported", excluded_by_plan AS "excludedByPlan",
        cursor_resumed AS "cursorResumed", error_message AS "errorMessage",
        parent_sync_run_id AS "parentSyncRunId", attempt_number AS "attemptNumber",
        variant_completeness_status AS "variantCompletenessStatus",
        variant_completeness_json AS "variantCompleteness",
        pagination_metadata_json AS "paginationMetadata",
        started_at AS "startedAt", completed_at AS "completedAt",
        created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        run.id,
        run.workspaceId,
        run.shopDomain,
        run.status,
        run.productsDiscovered,
        run.productsImported,
        run.variantsImported,
        run.excludedByPlan,
        run.cursorResumed || null,
        run.errorMessage || null,
        run.parentSyncRunId || null,
        run.attemptNumber ?? 1,
        run.variantCompletenessStatus || 'complete',
        JSON.stringify(run.variantCompleteness || {}),
        JSON.stringify(run.paginationMetadata || {}),
        run.startedAt,
        run.completedAt || null,
      ]
    );

    return res.rows[0] ? this.mapShopifySyncRunRow(res.rows[0]) : run;
  }

  async updateShopifySyncRun(
    id: string,
    workspaceId: string,
    updates: Partial<import('../shopify/types').ShopifySyncRunRecord>
  ): Promise<import('../shopify/types').ShopifySyncRunRecord> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const params: any[] = [id, workspaceId];

    if (updates.status !== undefined) {
      params.push(updates.status);
      setClauses.push(`status = $${params.length}`);
    }
    if (updates.productsDiscovered !== undefined) {
      params.push(updates.productsDiscovered);
      setClauses.push(`products_discovered = $${params.length}`);
    }
    if (updates.productsImported !== undefined) {
      params.push(updates.productsImported);
      setClauses.push(`products_imported = $${params.length}`);
    }
    if (updates.variantsImported !== undefined) {
      params.push(updates.variantsImported);
      setClauses.push(`variants_imported = $${params.length}`);
    }
    if (updates.excludedByPlan !== undefined) {
      params.push(updates.excludedByPlan);
      setClauses.push(`excluded_by_plan = $${params.length}`);
    }
    if (updates.errorMessage !== undefined) {
      params.push(updates.errorMessage);
      setClauses.push(`error_message = $${params.length}`);
    }
    if (updates.completedAt !== undefined) {
      params.push(updates.completedAt);
      setClauses.push(`completed_at = $${params.length}`);
    }
    if (updates.cursorResumed !== undefined) {
      params.push(updates.cursorResumed);
      setClauses.push(`cursor_resumed = $${params.length}`);
    }
    if (updates.parentSyncRunId !== undefined) {
      params.push(updates.parentSyncRunId);
      setClauses.push(`parent_sync_run_id = $${params.length}`);
    }
    if (updates.attemptNumber !== undefined) {
      params.push(updates.attemptNumber);
      setClauses.push(`attempt_number = $${params.length}`);
    }
    if (updates.variantCompletenessStatus !== undefined) {
      params.push(updates.variantCompletenessStatus);
      setClauses.push(`variant_completeness_status = $${params.length}`);
    }
    if (updates.variantCompleteness !== undefined) {
      params.push(JSON.stringify(updates.variantCompleteness || {}));
      setClauses.push(`variant_completeness_json = $${params.length}::jsonb`);
    }
    if (updates.paginationMetadata !== undefined) {
      params.push(JSON.stringify(updates.paginationMetadata || {}));
      setClauses.push(`pagination_metadata_json = $${params.length}::jsonb`);
    }

    const res = await this.pool.query<any>(
      `UPDATE shopify_sync_runs
       SET ${setClauses.join(', ')}
       WHERE id = $1 AND workspace_id = $2
       RETURNING 
         id, workspace_id AS "workspaceId", shop_domain AS "shopDomain", status,
         products_discovered AS "productsDiscovered", products_imported AS "productsImported",
         variants_imported AS "variantsImported", excluded_by_plan AS "excludedByPlan",
         cursor_resumed AS "cursorResumed", error_message AS "errorMessage",
         parent_sync_run_id AS "parentSyncRunId", attempt_number AS "attemptNumber",
         variant_completeness_status AS "variantCompletenessStatus",
         variant_completeness_json AS "variantCompleteness",
         pagination_metadata_json AS "paginationMetadata",
         started_at AS "startedAt", completed_at AS "completedAt",
         created_at AS "createdAt", updated_at AS "updatedAt"`,
      params
    );

    if (res.rows.length === 0) {
      throw new Error(`ShopifySyncRun ${id} not found for workspace ${workspaceId}.`);
    }

    return this.mapShopifySyncRunRow(res.rows[0]);
  }

  async getLatestShopifySyncRun(workspaceId: string): Promise<import('../shopify/types').ShopifySyncRunRecord | null> {
    const res = await this.pool.query<any>(
      `SELECT 
        id, workspace_id AS "workspaceId", shop_domain AS "shopDomain", status,
        products_discovered AS "productsDiscovered", products_imported AS "productsImported",
        variants_imported AS "variantsImported", excluded_by_plan AS "excludedByPlan",
        cursor_resumed AS "cursorResumed", error_message AS "errorMessage",
        parent_sync_run_id AS "parentSyncRunId", attempt_number AS "attemptNumber",
        variant_completeness_status AS "variantCompletenessStatus",
        variant_completeness_json AS "variantCompleteness",
        pagination_metadata_json AS "paginationMetadata",
        started_at AS "startedAt", completed_at AS "completedAt",
        created_at AS "createdAt", updated_at AS "updatedAt"
       FROM shopify_sync_runs
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [workspaceId]
    );

    if (res.rows.length === 0) return null;
    return this.mapShopifySyncRunRow(res.rows[0]);
  }

  async getShopifySyncRunById(id: string, workspaceId: string): Promise<import('../shopify/types').ShopifySyncRunRecord | null> {
    const res = await this.pool.query<any>(
      `SELECT 
        id, workspace_id AS "workspaceId", shop_domain AS "shopDomain", status,
        products_discovered AS "productsDiscovered", products_imported AS "productsImported",
        variants_imported AS "variantsImported", excluded_by_plan AS "excludedByPlan",
        cursor_resumed AS "cursorResumed", error_message AS "errorMessage",
        parent_sync_run_id AS "parentSyncRunId", attempt_number AS "attemptNumber",
        variant_completeness_status AS "variantCompletenessStatus",
        variant_completeness_json AS "variantCompleteness",
        pagination_metadata_json AS "paginationMetadata",
        started_at AS "startedAt", completed_at AS "completedAt",
        created_at AS "createdAt", updated_at AS "updatedAt"
       FROM shopify_sync_runs
       WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );

    if (res.rows.length === 0) return null;
    return this.mapShopifySyncRunRow(res.rows[0]);
  }

  async getShopifySyncRuns(workspaceId: string, limit = 20): Promise<import('../shopify/types').ShopifySyncRunRecord[]> {
    const res = await this.pool.query<any>(
      `SELECT 
        id, workspace_id AS "workspaceId", shop_domain AS "shopDomain", status,
        products_discovered AS "productsDiscovered", products_imported AS "productsImported",
        variants_imported AS "variantsImported", excluded_by_plan AS "excludedByPlan",
        cursor_resumed AS "cursorResumed", error_message AS "errorMessage",
        parent_sync_run_id AS "parentSyncRunId", attempt_number AS "attemptNumber",
        variant_completeness_status AS "variantCompletenessStatus",
        variant_completeness_json AS "variantCompleteness",
        pagination_metadata_json AS "paginationMetadata",
        started_at AS "startedAt", completed_at AS "completedAt",
        created_at AS "createdAt", updated_at AS "updatedAt"
       FROM shopify_sync_runs
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [workspaceId, limit]
    );

    return res.rows.map(r => this.mapShopifySyncRunRow(r));
  }

  async claimShopifyWebhookEvent(event: import('../shopify/types').ShopifyWebhookEventRecord): Promise<{ claimed: boolean; event: import('../shopify/types').ShopifyWebhookEventRecord | null }> {
    try {
      const res = await this.pool.query<any>(
        `INSERT INTO shopify_webhook_events (
          id, workspace_id, shop_domain, event_id, topic, delivery_id,
          payload_json, status, retry_count, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW(), NOW())
        ON CONFLICT (shop_domain, topic, event_id) DO NOTHING
        RETURNING id`,
        [
          event.id,
          event.workspaceId,
          event.shopDomain,
          event.eventId,
          event.topic,
          event.deliveryId || null,
          JSON.stringify(event.payload || {}),
          event.status,
          event.retryCount,
        ]
      );

      if (res.rowCount === 0) {
        // Event already exists
        const existingRes = await this.pool.query<any>(
          `SELECT 
            id, workspace_id AS "workspaceId", shop_domain AS "shopDomain",
            event_id AS "eventId", topic, delivery_id AS "deliveryId",
            payload_json AS "payload", status, retry_count AS "retryCount",
            last_error AS "lastError", processed_at AS "processedAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
           FROM shopify_webhook_events
           WHERE shop_domain = $1 AND topic = $2 AND event_id = $3`,
          [event.shopDomain, event.topic, event.eventId]
        );
        return { claimed: false, event: existingRes.rows[0] || null };
      }

      return { claimed: true, event };
    } catch (err: any) {
      console.error('[AIXSHOP PostgresRepository] Error claiming webhook event:', err);
      return { claimed: false, event: null };
    }
  }

  async updateShopifyWebhookEventStatus(eventId: string, shopDomain: string, topic: string, status: 'processing' | 'processed' | 'failed' | 'ignored', error?: string): Promise<void> {
    await this.pool.query(
      `UPDATE shopify_webhook_events
       SET status = $4,
           last_error = $5,
           processed_at = CASE WHEN $4 = 'processed' THEN NOW() ELSE processed_at END,
           updated_at = NOW()
       WHERE shop_domain = $1 AND topic = $2 AND event_id = $3`,
      [shopDomain, topic, eventId, status, error || null]
    );
  }

  async withShopifyRefreshLock<T>(
    workspaceId: string,
    fn: (
      connection: import('../shopify/types').ShopifyConnectionRecord,
      saveConnection: (conn: import('../shopify/types').ShopifyConnectionRecord) => Promise<import('../shopify/types').ShopifyConnectionRecord>
    ) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<any>(
        `SELECT 
          id, workspace_id AS "workspaceId", shop_domain AS "shopDomain",
          access_token_encrypted AS "accessTokenEncrypted",
          refresh_token_encrypted AS "refreshTokenEncrypted",
          token_expires_at AS "tokenExpiresAt",
          refresh_token_expires_at AS "refreshTokenExpiresAt",
          last_refreshed_at AS "lastRefreshedAt",
          webhook_subscriptions_json AS "webhookSubscriptions",
          webhook_last_verified_at AS "webhookLastVerifiedAt",
          webhook_verification_status AS "webhookVerificationStatus",
          webhook_verification_details AS "webhookVerificationDetails",
          granted_scopes AS "grantedScopes",
          key_version AS "keyVersion",
          status, installed_at AS "installedAt",
          last_verified_at AS "lastVerifiedAt",
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM shopify_connections
        WHERE workspace_id = $1
        FOR UPDATE`,
        [workspaceId]
      );

      if (res.rows.length === 0) {
        throw new Error(`[AIXSHOP Shopify Refresh] No Shopify connection found for workspace ${workspaceId}.`);
      }

      const lockedConn = this.mapShopifyConnectionRow(res.rows[0]);

      const saveConnection = async (conn: import('../shopify/types').ShopifyConnectionRecord): Promise<import('../shopify/types').ShopifyConnectionRecord> => {
        await client.query(
          `INSERT INTO shopify_connections (
            id, workspace_id, shop_domain, access_token_encrypted, refresh_token_encrypted,
            token_expires_at, refresh_token_expires_at, last_refreshed_at, webhook_subscriptions_json,
            webhook_last_verified_at, webhook_verification_status, webhook_verification_details,
            granted_scopes, key_version, status, installed_at,
            last_verified_at, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, NOW(), NOW())
          ON CONFLICT (workspace_id) DO UPDATE SET
            shop_domain = EXCLUDED.shop_domain,
            access_token_encrypted = EXCLUDED.access_token_encrypted,
            refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
            token_expires_at = EXCLUDED.token_expires_at,
            refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
            last_refreshed_at = EXCLUDED.last_refreshed_at,
            webhook_subscriptions_json = EXCLUDED.webhook_subscriptions_json,
            webhook_last_verified_at = EXCLUDED.webhook_last_verified_at,
            webhook_verification_status = EXCLUDED.webhook_verification_status,
            webhook_verification_details = EXCLUDED.webhook_verification_details,
            granted_scopes = EXCLUDED.granted_scopes,
            key_version = EXCLUDED.key_version,
            status = EXCLUDED.status,
            last_verified_at = EXCLUDED.last_verified_at,
            updated_at = NOW()`,
          [
            conn.id,
            conn.workspaceId,
            conn.shopDomain,
            conn.accessTokenEncrypted,
            conn.refreshTokenEncrypted || null,
            conn.tokenExpiresAt || null,
            conn.refreshTokenExpiresAt || null,
            conn.lastRefreshedAt || null,
            JSON.stringify(conn.webhookSubscriptions || []),
            conn.webhookLastVerifiedAt || null,
            conn.webhookVerificationStatus || 'not_configured',
            JSON.stringify(conn.webhookVerificationDetails || {}),
            conn.grantedScopes,
            conn.keyVersion,
            conn.status,
            conn.installedAt,
            conn.lastVerifiedAt,
          ]
        );
        return conn;
      };

      const result = await fn(lockedConn, saveConnection);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[AIXSHOP PostgresRepository] Rollback error in withShopifyRefreshLock:', rollbackErr);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getWorkspaceBusinessProfile(workspaceId: string): Promise<import('../../domain/businessProfile/types').WorkspaceBusinessProfile | null> {
    const res = await this.pool.query<any>(
      `SELECT 
        id, workspace_id AS "workspaceId",
        legal_business_name AS "legalBusinessName",
        public_brand_name AS "publicBrandName",
        brand_description AS "brandDescription",
        official_website AS "officialWebsite",
        primary_domain AS "primaryDomain",
        contact_email AS "contactEmail",
        contact_phone AS "contactPhone",
        business_address AS "businessAddress",
        support_url AS "supportUrl",
        shipping_policy_url AS "shippingPolicyUrl",
        return_policy_url AS "returnPolicyUrl",
        refund_policy_url AS "refundPolicyUrl",
        privacy_policy_url AS "privacyPolicyUrl",
        terms_of_service_url AS "termsOfServiceUrl",
        logo_url AS "logoUrl",
        social_profiles_json AS "socialProfiles",
        verification_status AS "verificationStatus",
        verification_source AS "verificationSource",
        verification_evidence_json AS "verificationEvidence",
        last_verified_at AS "lastVerifiedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
       FROM workspace_business_profiles
       WHERE workspace_id = $1`,
      [workspaceId]
    );

    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    const normalizeStatus = (s: string): import('../../domain/businessProfile/types').BusinessVerificationStatus => {
      if (s === 'merchant_verified') return 'merchant_self_declared';
      if (s === 'unverified') return 'not_verified';
      if (
        s === 'not_verified' ||
        s === 'merchant_self_declared' ||
        s === 'verification_pending' ||
        s === 'verification_failed' ||
        s === 'independently_verified'
      ) {
        return s;
      }
      return 'not_verified';
    };

    return {
      ...r,
      socialProfiles: Array.isArray(r.socialProfiles) ? r.socialProfiles : [],
      verificationStatus: normalizeStatus(r.verificationStatus),
      verificationSource: r.verificationSource || null,
      verificationEvidence: typeof r.verificationEvidence === 'string'
        ? JSON.parse(r.verificationEvidence)
        : (r.verificationEvidence || null),
      lastVerifiedAt: r.lastVerifiedAt ? new Date(r.lastVerifiedAt).toISOString() : null,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
    };
  }

  async saveWorkspaceBusinessProfile(profile: import('../../domain/businessProfile/types').WorkspaceBusinessProfile): Promise<import('../../domain/businessProfile/types').WorkspaceBusinessProfile> {
    const res = await this.pool.query<any>(
      `INSERT INTO workspace_business_profiles (
        id, workspace_id, legal_business_name, public_brand_name, brand_description,
        official_website, primary_domain, contact_email, contact_phone, business_address,
        support_url, shipping_policy_url, return_policy_url, refund_policy_url,
        privacy_policy_url, terms_of_service_url, logo_url, social_profiles_json,
        verification_status, verification_source, verification_evidence_json, last_verified_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21::jsonb, $22, NOW(), NOW())
      ON CONFLICT (workspace_id) DO UPDATE SET
        legal_business_name = EXCLUDED.legal_business_name,
        public_brand_name = EXCLUDED.public_brand_name,
        brand_description = EXCLUDED.brand_description,
        official_website = EXCLUDED.official_website,
        primary_domain = EXCLUDED.primary_domain,
        contact_email = EXCLUDED.contact_email,
        contact_phone = EXCLUDED.contact_phone,
        business_address = EXCLUDED.business_address,
        support_url = EXCLUDED.support_url,
        shipping_policy_url = EXCLUDED.shipping_policy_url,
        return_policy_url = EXCLUDED.return_policy_url,
        refund_policy_url = EXCLUDED.refund_policy_url,
        privacy_policy_url = EXCLUDED.privacy_policy_url,
        terms_of_service_url = EXCLUDED.terms_of_service_url,
        logo_url = EXCLUDED.logo_url,
        social_profiles_json = EXCLUDED.social_profiles_json,
        verification_status = EXCLUDED.verification_status,
        verification_source = EXCLUDED.verification_source,
        verification_evidence_json = EXCLUDED.verification_evidence_json,
        last_verified_at = EXCLUDED.last_verified_at,
        updated_at = NOW()
      RETURNING *`,
      [
        profile.id,
        profile.workspaceId,
        profile.legalBusinessName || null,
        profile.publicBrandName || null,
        profile.brandDescription || null,
        profile.officialWebsite || null,
        profile.primaryDomain || null,
        profile.contactEmail || null,
        profile.contactPhone || null,
        profile.businessAddress || null,
        profile.supportUrl || null,
        profile.shippingPolicyUrl || null,
        profile.returnPolicyUrl || null,
        profile.refundPolicyUrl || null,
        profile.privacyPolicyUrl || null,
        profile.termsOfServiceUrl || null,
        profile.logoUrl || null,
        JSON.stringify(profile.socialProfiles || []),
        profile.verificationStatus || 'not_verified',
        profile.verificationSource || null,
        JSON.stringify(profile.verificationEvidence || {}),
        profile.lastVerifiedAt || null,
      ]
    );

    const r = res.rows[0];
    return {
      ...profile,
      id: r.id,
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  async saveVisibilityImport(record: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord): Promise<import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord> {
    await this.pool.query(
      `INSERT INTO ai_visibility_imports (
        id, workspace_id, filename, row_count, rejected_row_count, status, errors_json,
        reporting_period_start, reporting_period_end, source_platform, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, NOW())`,
      [
        record.id,
        record.workspaceId,
        record.filename,
        record.rowCount,
        record.rejectedRowCount ?? 0,
        record.status || 'completed',
        JSON.stringify(record.errors || []),
        record.reportingPeriodStart || null,
        record.reportingPeriodEnd || null,
        record.sourcePlatform || 'merchant_upload',
      ]
    );
    return record;
  }

  async saveVisibilityMetrics(metrics: import('../../domain/monitoring/aiVisibilityTypes').VisibilityMetricRecord[]): Promise<void> {
    for (const m of metrics) {
      await this.pool.query(
        `INSERT INTO ai_visibility_metrics (
          id, workspace_id, import_id, observation_date, platform, brand_mentions, product_mentions, website_clicks, discovery_topic, evidence_source, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (workspace_id, observation_date, platform, discovery_topic) DO UPDATE SET
          import_id = EXCLUDED.import_id,
          brand_mentions = EXCLUDED.brand_mentions,
          product_mentions = EXCLUDED.product_mentions,
          website_clicks = EXCLUDED.website_clicks,
          evidence_source = EXCLUDED.evidence_source`,
        [
          m.id,
          m.workspaceId,
          m.importId || null,
          m.observationDate,
          m.platform,
          m.brandMentions,
          m.productMentions,
          m.websiteClicks,
          m.discoveryTopic || '',
          m.evidenceSource || null,
        ]
      );
    }
  }

  async saveVisibilityImportAtomic(
    record: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord,
    metrics: import('../../domain/monitoring/aiVisibilityTypes').VisibilityMetricRecord[]
  ): Promise<{ importRecord: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord; metricsSaved: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ai_visibility_imports (
          id, workspace_id, filename, row_count, rejected_row_count, status, errors_json,
          reporting_period_start, reporting_period_end, source_platform, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, NOW())`,
        [
          record.id,
          record.workspaceId,
          record.filename,
          record.rowCount,
          record.rejectedRowCount ?? 0,
          record.status || 'completed',
          JSON.stringify(record.errors || []),
          record.reportingPeriodStart || null,
          record.reportingPeriodEnd || null,
          record.sourcePlatform || 'merchant_upload',
        ]
      );

      for (const m of metrics) {
        await client.query(
          `INSERT INTO ai_visibility_metrics (
            id, workspace_id, import_id, observation_date, platform, brand_mentions, product_mentions, website_clicks, discovery_topic, evidence_source, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
          ON CONFLICT (workspace_id, observation_date, platform, discovery_topic) DO UPDATE SET
            import_id = EXCLUDED.import_id,
            brand_mentions = EXCLUDED.brand_mentions,
            product_mentions = EXCLUDED.product_mentions,
            website_clicks = EXCLUDED.website_clicks,
            evidence_source = EXCLUDED.evidence_source`,
          [
            m.id,
            m.workspaceId,
            m.importId || null,
            m.observationDate,
            m.platform,
            m.brandMentions,
            m.productMentions,
            m.websiteClicks,
            m.discoveryTopic || '',
            m.evidenceSource || null,
          ]
        );
      }

      await client.query('COMMIT');
      return { importRecord: record, metricsSaved: metrics.length };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getVisibilitySummary(workspaceId: string): Promise<import('../../domain/monitoring/aiVisibilityTypes').VisibilitySummary> {
    const metricsRes = await this.pool.query<any>(
      `SELECT 
        id, workspace_id AS "workspaceId", import_id AS "importId",
        observation_date::text AS "observationDate", platform,
        brand_mentions AS "brandMentions", product_mentions AS "productMentions",
        website_clicks AS "websiteClicks", discovery_topic AS "discoveryTopic",
        evidence_source AS "evidenceSource", created_at AS "createdAt"
       FROM ai_visibility_metrics
       WHERE workspace_id = $1
       ORDER BY observation_date DESC
       LIMIT 100`,
      [workspaceId]
    );

    const importsRes = await this.pool.query<any>(
      `SELECT 
        id, workspace_id AS "workspaceId", filename, row_count AS "rowCount",
        rejected_row_count AS "rejectedRowCount", status, errors_json AS "errors",
        reporting_period_start::text AS "reportingPeriodStart",
        reporting_period_end::text AS "reportingPeriodEnd",
        source_platform AS "sourcePlatform", created_at AS "createdAt"
       FROM ai_visibility_imports
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [workspaceId]
    );

    const metrics = metricsRes.rows;
    const imports = importsRes.rows;

    if (metrics.length === 0 && imports.length === 0) {
      return {
        connected: false,
        status: 'DATA_SOURCE_NOT_CONNECTED',
        message: 'DATA SOURCE NOT CONNECTED - No official AI platform analytics API or verified telemetry connected',
        totalBrandMentions: 0,
        totalProductMentions: 0,
        totalWebsiteClicks: 0,
        platforms: [],
        recentObservations: [],
        imports: [],
      };
    }

    let totalBrandMentions = 0;
    let totalProductMentions = 0;
    let totalWebsiteClicks = 0;
    const platformMap = new Map<string, { mentions: number; clicks: number }>();

    for (const m of metrics) {
      totalBrandMentions += Number(m.brandMentions || 0);
      totalProductMentions += Number(m.productMentions || 0);
      totalWebsiteClicks += Number(m.websiteClicks || 0);

      const plat = platformMap.get(m.platform) || { mentions: 0, clicks: 0 };
      plat.mentions += Number(m.brandMentions || 0) + Number(m.productMentions || 0);
      plat.clicks += Number(m.websiteClicks || 0);
      platformMap.set(m.platform, plat);
    }

    const platforms = Array.from(platformMap.entries()).map(([platform, data]) => ({
      platform,
      mentions: data.mentions,
      clicks: data.clicks,
    }));

    return {
      connected: true,
      status: 'CONNECTED',
      message: 'Merchant-verified AI discovery analytics active',
      totalBrandMentions,
      totalProductMentions,
      totalWebsiteClicks,
      platforms,
      recentObservations: metrics,
      imports,
    };
  }
}


