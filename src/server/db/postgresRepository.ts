import { Pool, PoolClient } from 'pg';
import { 
  DatabaseRepository, 
  CreateUserData, 
  CreateWorkspaceData, 
  CreateSessionData,
  RegisterUserData,
  RegisterUserResult,
  SchemaReadinessResult
} from './repository';
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
      `SELECT id, provider, event_id AS "eventId", event_type AS "eventType", idempotency_key AS "idempotencyKey", payload_json AS "payload", status, processed_at AS "processedAt", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM billing_events
       WHERE event_id = $1`,
      [eventId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async saveBillingEvent(event: BillingEventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO billing_events (id, provider, event_id, event_type, idempotency_key, payload_json, status, processed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW(), NOW(), NOW())
       ON CONFLICT (provider, event_id) DO UPDATE SET
         status = EXCLUDED.status,
         payload_json = EXCLUDED.payload_json,
         processed_at = NOW(),
         updated_at = NOW()`,
      [
        event.id,
        event.provider,
        event.eventId,
        event.eventType,
        event.idempotencyKey,
        JSON.stringify(event.payload || {}),
        event.status,
      ]
    );
  }

  async claimBillingEvent(event: BillingEventRecord): Promise<{ claimed: boolean; event: BillingEventRecord | null }> {
    // Atomic insert-or-claim query:
    // 1. If row does not exist, inserts with status = 'processing'.
    // 2. If row exists and status is 'failed', or status is 'processing' older than 5 minutes (stale worker), claims it.
    // 3. Otherwise does not update and returns 0 rows.
    const res = await this.pool.query<any>(
      `INSERT INTO billing_events (id, provider, event_id, event_type, idempotency_key, payload_json, status, processed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'processing', NOW(), NOW(), NOW())
       ON CONFLICT (provider, event_id) DO UPDATE SET
         status = 'processing',
         processed_at = NOW(),
         updated_at = NOW()
       WHERE billing_events.status = 'failed'
          OR (billing_events.status = 'processing' AND billing_events.processed_at < NOW() - INTERVAL '5 minutes')
       RETURNING id, provider, event_id AS "eventId", event_type AS "eventType", idempotency_key AS "idempotencyKey", payload_json AS "payload", status, processed_at AS "processedAt"`,
      [
        event.id,
        event.provider,
        event.eventId,
        event.eventType,
        event.idempotencyKey,
        JSON.stringify(event.payload || {}),
      ]
    );

    if (res.rows.length > 0) {
      return { claimed: true, event: res.rows[0] };
    }

    const existing = await this.getBillingEventById(event.eventId);
    return { claimed: false, event: existing };
  }

  async updateBillingEventStatus(
    eventId: string,
    status: 'processing' | 'processed' | 'failed' | 'ignored',
    payload?: any
  ): Promise<void> {
    if (payload !== undefined) {
      await this.pool.query(
        `UPDATE billing_events
         SET status = $2, payload_json = $3::jsonb, updated_at = NOW()
         WHERE event_id = $1`,
        [eventId, status, JSON.stringify(payload)]
      );
    } else {
      await this.pool.query(
        `UPDATE billing_events
         SET status = $2, updated_at = NOW()
         WHERE event_id = $1`,
        [eventId, status]
      );
    }
  }

  async applyBillingTransition(params: {
    eventId: string;
    subscription: SubscriptionRecord;
    storeProfileUpdate?: { tier: PlanTier; skuLimit?: number };
    markProcessed?: boolean;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

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

      // 3. Mark billing event processed
      if (params.markProcessed !== false) {
        await client.query(
          `UPDATE billing_events
           SET status = 'processed',
               processed_at = NOW(),
               updated_at = NOW()
           WHERE event_id = $1`,
          [params.eventId]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

