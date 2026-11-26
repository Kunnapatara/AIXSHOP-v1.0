import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  UpdateAuditRunData,
  CatalogVersionConflictError,
  CatalogVersionValidationError,
  WorkspaceLockOrderError,
  DeleteAccountResult,
  WorkspaceBillingRecipient,
} from './repository';
import { computeMigrationChecksum, getDefaultMigrationsDir, sanitizeDiagnosticMessage } from './migrate';
import {
  TopicPresenceState,
  VisibilityConflictPolicy,
  VisibilityMetricRecord,
  VisibilityObservationConflict,
  VisibilityObservationConflictError,
  VisibilityObservationHistoryRecord,
} from '../../domain/monitoring/aiVisibilityTypes';
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
  ProductCandidate,
  EvidencePurpose,
  EvidenceReviewAuditEntry,
  ExternalVerificationStatus,
  ReviewerPrincipalType,
  ShopifyProductProvenanceRecord
} from '../../types';
import { ReviewerServicePrincipalRecord } from '../security/reviewerAuth';
import { ExternalRegistryVerificationEvaluation } from '../services/externalRegistryService';
import {
  buildTrustedGtinVerificationContext,
  computeEvidenceIntegrityHash,
  sanitizeAndValidateImportCandidates,
} from '../security/catalogSanitizer';
import { StoragePayloadV1 } from '../../domain/storage/storageTypes';
import {
  SubscriptionRecord,
  BillingEventRecord,
  BillingEventStatus,
  PlanTier,
  BillingEmailDeliveryRecord,
  BillingEmailDeliveryStatus,
  BillingEmailEventType,
} from '../billing/types';
import {
  ShopifyWriteBackOperationRecord,
  ShopifyWriteBackStatus,
} from '../shopify/types';
import {
  GuestTransferAuditRecord,
  GuestTransferAuthorizationRecord,
  GuestTransferCommitResult,
  GuestTransferConflictStrategy,
} from '../../domain/catalog/guestTransfer';
import { GuestTransferError } from '../services/guestTransferService';
import { executeActionApproval, executeActionDismissal, executeActionRecheck, executeCatalogImport } from '../../domain/catalog/catalogMutationService';
import { 
  calculateImportUsage, 
  checkPlanQuota, 
  countCatalogSkus, 
  PlanQuotaExceededError 
} from '../services/entitlementService';

class VisibilityDuplicateHashSentinel extends Error {
  constructor() {
    super('Duplicate visibility import content hash');
  }
}

interface WorkspaceLockContext {
  client: PoolClient;
  heldWorkspaceLocks: Set<string>;
  inTransaction: boolean;
  savepointDepth: number;
  poisoned: boolean;
}

export class PostgresRepository implements DatabaseRepository {
  private pool: Pool;
  private lockStorage = new AsyncLocalStorage<WorkspaceLockContext>();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  getBackendType(): 'postgres' {
    return 'postgres';
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private getActiveClient(): PoolClient | null {
    return this.lockStorage.getStore()?.client ?? null;
  }

  private async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount: number | null }> {
    const activeClient = this.getActiveClient();
    if (activeClient) {
      return activeClient.query(sql, params) as any;
    }
    return this.pool.query(sql, params) as any;
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const ctx = this.lockStorage.getStore();
    if (ctx) {
      if (!ctx.inTransaction) {
        try {
          await ctx.client.query('BEGIN');
        } catch (beginErr) {
          ctx.poisoned = true;
          throw beginErr;
        }
        ctx.inTransaction = true;
        try {
          const result = await fn(ctx.client);
          await ctx.client.query('COMMIT');
          return result;
        } catch (err) {
          try {
            await ctx.client.query('ROLLBACK');
          } catch (rollbackErr) {
            ctx.poisoned = true;
            console.error('[AIXSHOP Database] Rollback failed; connection marked for destruction:', rollbackErr);
          }
          throw err;
        } finally {
          ctx.inTransaction = false;
        }
      } else {
        ctx.savepointDepth += 1;
        const spName = `aixshop_sp_${ctx.savepointDepth}`;
        try {
          await ctx.client.query(`SAVEPOINT ${spName}`);
        } catch (spErr) {
          ctx.savepointDepth -= 1;
          ctx.poisoned = true;
          throw spErr;
        }
        try {
          const result = await fn(ctx.client);
          await ctx.client.query(`RELEASE SAVEPOINT ${spName}`);
          return result;
        } catch (err) {
          try {
            await ctx.client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
          } catch (rollbackErr) {
            ctx.poisoned = true;
            console.error('[AIXSHOP Database] Savepoint rollback failed; connection marked for destruction:', rollbackErr);
          }
          throw err;
        } finally {
          ctx.savepointDepth -= 1;
        }
      }
    }

    const client = await this.pool.connect();
    let begun = false;
    let poisoned = false;
    let released = false;
    const releaseOnce = (destroy: boolean) => {
      if (released) return;
      released = true;
      try {
        if (destroy) {
          (client.release as any)(true);
        } else {
          client.release();
        }
      } catch {
        // ignore secondary release errors while preserving original operation error
      }
    };

    try {
      try {
        await client.query('BEGIN');
        begun = true;
      } catch (beginErr) {
        poisoned = true;
        throw beginErr;
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      if (begun) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          poisoned = true;
          console.error('[AIXSHOP Database] Rollback failed; connection marked for destruction:', rollbackErr);
        }
      }
      throw err;
    } finally {
      releaseOnce(poisoned);
    }
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.query('SELECT 1');
      return res.rowCount !== null && res.rowCount > 0;
    } catch (err) {
      console.warn('[AIXSHOP Database] PostgreSQL connectivity ping failed:', sanitizeDiagnosticMessage(err));
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
      'ai_visibility_observation_history',
      'auth_rate_limits',
      'password_reset_tokens',
      'workspace_operation_leases',
      'evidence_review_audit_log',
      'shopify_product_provenance',
      'reviewer_service_principals',
      'guest_transfer_authorizations',
      'guest_transfer_audit_log',
      'shopify_writeback_operations',
      'billing_email_deliveries',
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
              (table_name = 'products' AND column_name = 'workspace_id') OR
              (table_name = 'schema_migrations' AND column_name = 'checksum')
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

        // Verify applied migrations (001 through 015 are all required for current version)
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
          '011_corrective_integrity_and_visibility_provenance.sql',
          '012_production_blockers_integrity.sql',
          '013_billing_webhook_recovery.sql',
          '014_auth_recovery_and_operation_leases.sql',
          '015_gtin_evidence_trust.sql',
          '016_source_classification_and_domain_cleanup.sql',
          '017_reviewer_identity_and_registry_trust.sql',
          '018_guest_transfer_authorizations.sql',
          '019_writeback_and_billing_emails.sql',
        ];
        const pendingMigrations = requiredMigrations.filter(m => !appliedMigrations.includes(m));

        if (pendingMigrations.length > 0) {
          return {
            isReady: false,
            pendingMigrations,
            error: `Required migration "${pendingMigrations[0]}" has not been applied. Run "npm run db:migrate".`,
          };
        }

        // Verify stored migration SHA-256 checksums when checksum column is present
        if (colMap.has('schema_migrations.checksum')) {
          const checksumRes = await client.query<{ id: string; checksum: string | null }>(
            'SELECT id, checksum FROM schema_migrations ORDER BY id ASC'
          );
          const migrationsDir = getDefaultMigrationsDir();
          if (fs.existsSync(migrationsDir)) {
            for (const row of checksumRes.rows) {
              const migPath = path.join(migrationsDir, row.id);
              if (!fs.existsSync(migPath)) {
                return {
                  isReady: false,
                  error: `Database migration integrity error: applied migration file "${row.id}" is missing on disk.`,
                };
              }
              if (row.checksum) {
                const diskChecksum = computeMigrationChecksum(fs.readFileSync(migPath, 'utf8'));
                if (row.checksum !== diskChecksum) {
                  return {
                    isReady: false,
                    error: `Database migration integrity error: checksum mismatch for applied migration "${row.id}".`,
                  };
                }
              }
            }
          }
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
          is_partial_index?: boolean;
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
            ), '') AS target_columns,
            COALESCE(idx.indpred IS NOT NULL, false) AS is_partial_index
          FROM pg_constraint c
          JOIN pg_class src_t ON c.conrelid = src_t.oid
          JOIN pg_namespace src_ns ON src_t.relnamespace = src_ns.oid
          LEFT JOIN pg_class tgt_t ON c.confrelid = tgt_t.oid
          LEFT JOIN pg_namespace tgt_ns ON tgt_t.relnamespace = tgt_ns.oid
          LEFT JOIN pg_index idx ON idx.indexrelid = c.conindid
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

        // 4.1 Verify unique constraint on stores(workspace_id, id) with exact ordinal order and full-table coverage
        const expectedStoreCols = ['workspace_id', 'id'];
        const storeUniqueConstraint = catalogRows.find(
          r =>
            (r.source_schema || activeSchema) === activeSchema &&
            r.source_table === 'stores' &&
            ['u', 'p'].includes(r.constraint_type) &&
            r.is_partial_index !== true &&
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
            r.is_partial_index !== true &&
            arraysEqual(parseCols(r.source_columns), expectedAuditRunCols)
        );

        if (!auditRunUniqueConstraint) {
          return {
            isReady: false,
            error: 'Database schema integrity error: audit_runs table missing unique key on (workspace_id, id). Run "npm run db:migrate".',
          };
        }

        // 4.1c Verify unique constraint on shopify_sync_runs(workspace_id, id)
        const shopifySyncRunUniqueConstraint = catalogRows.find(
          r =>
            (r.source_schema || activeSchema) === activeSchema &&
            r.source_table === 'shopify_sync_runs' &&
            ['u', 'p'].includes(r.constraint_type) &&
            r.is_partial_index !== true &&
            arraysEqual(parseCols(r.source_columns), ['workspace_id', 'id'])
        );

        if (!shopifySyncRunUniqueConstraint) {
          return {
            isReady: false,
            error: 'Database schema integrity error: shopify_sync_runs table missing unique key on (workspace_id, id). Run "npm run db:migrate".',
          };
        }

        // 4.1d Verify non-partial unique constraint on ai_visibility_metrics(workspace_id, observation_date, platform, discovery_topic)
        const visibilityMetricUniqueConstraint = catalogRows.find(
          r =>
            (r.source_schema || activeSchema) === activeSchema &&
            r.source_table === 'ai_visibility_metrics' &&
            ['u', 'p'].includes(r.constraint_type) &&
            r.is_partial_index !== true &&
            arraysEqual(parseCols(r.source_columns), ['workspace_id', 'observation_date', 'platform', 'discovery_topic'])
        );

        if (!visibilityMetricUniqueConstraint) {
          return {
            isReady: false,
            error: 'Database schema integrity error: ai_visibility_metrics table missing unique key on (workspace_id, observation_date, platform, discovery_topic). Run "npm run db:migrate".',
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
          {
            sourceTable: 'shopify_sync_runs',
            sourceColumns: ['workspace_id', 'parent_sync_run_id'],
            targetTable: 'shopify_sync_runs',
            targetColumns: ['workspace_id', 'id'],
            description: 'shopify_sync_runs(workspace_id, parent_sync_run_id) -> shopify_sync_runs(workspace_id, id)',
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
              'shopify_sync_runs(workspace_id, id) UNIQUE',
              'ai_visibility_metrics(workspace_id, observation_date, platform, discovery_topic) UNIQUE',
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

  async consumeRateLimit(
    key: string,
    maxAttempts: number,
    windowMs: number
  ): Promise<{ allowed: boolean; count: number; resetAt: number }> {
    const safeWindowMs = Math.max(1000, windowMs);
    const res = await this.query<{ attempt_count: number; reset_at: string | Date }>(
      `INSERT INTO auth_rate_limits (rate_key, attempt_count, reset_at, updated_at)
       VALUES ($1, 1, clock_timestamp() + ($2 * INTERVAL '1 millisecond'), clock_timestamp())
       ON CONFLICT (rate_key) DO UPDATE SET
         attempt_count = CASE
           WHEN auth_rate_limits.reset_at <= clock_timestamp() THEN 1
           ELSE auth_rate_limits.attempt_count + 1
         END,
         reset_at = CASE
           WHEN auth_rate_limits.reset_at <= clock_timestamp() THEN clock_timestamp() + ($2 * INTERVAL '1 millisecond')
           ELSE auth_rate_limits.reset_at
         END,
         updated_at = clock_timestamp()
       RETURNING attempt_count, reset_at`,
      [key, safeWindowMs]
    );

    // Opportunistic bounded purge of expired keys (~5% chance) to keep table compact without creating write storms
    if (Math.random() < 0.05) {
      await this.query(
        `DELETE FROM auth_rate_limits
         WHERE ctid IN (
           SELECT ctid FROM auth_rate_limits
           WHERE reset_at < clock_timestamp()
           LIMIT 200
         )`
      ).catch(() => {});
    }

    const row = res.rows[0];
    const count = Number(row?.attempt_count ?? 1);
    const resetAt = row?.reset_at ? new Date(row.reset_at).getTime() : Date.now() + safeWindowMs;
    return {
      allowed: count <= maxAttempts,
      count,
      resetAt,
    };
  }

  async registerUser(data: RegisterUserData): Promise<RegisterUserResult> {
    return this.withTransaction(async (client) => {

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
        `INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json, website_url, source_classification, shopify_connected, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, NOW(), NOW())`,
        [
          storeId,
          workspace.id,
          `${workspace.name} Store`,
          '',
          'USD',
          0,
          0,
          'standard',
          'Free Audit',
          JSON.stringify(defaultConnectors),
          '',
          'unconfigured',
          false,
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

      return { user, workspace, membership, session };
    });
  }

  async createUser(data: CreateUserData): Promise<UserRecord> {
    const query = `
      INSERT INTO users (id, email, password_hash, full_name, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING id, email, password_hash AS "passwordHash", full_name AS "fullName", created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const res = await this.query(query, [data.id, data.email, data.passwordHash, data.fullName]);
    return res.rows[0];
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const query = `
      SELECT id, email, password_hash AS "passwordHash", full_name AS "fullName", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `;
    const res = await this.query(query, [email]);
    return res.rows[0] || null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const query = `
      SELECT id, email, password_hash AS "passwordHash", full_name AS "fullName", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM users
      WHERE id = $1
      LIMIT 1
    `;
    const res = await this.query(query, [id]);
    return res.rows[0] || null;
  }

  async createWorkspace(
    data: CreateWorkspaceData, 
    ownerUserId: string
  ): Promise<{ workspace: WorkspaceRecord; membership: WorkspaceMembershipRecord }> {
    return this.withTransaction(async (client) => {
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
        INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json, website_url, source_classification, shopify_connected, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'USD', 0, 0, 'balanced', 'Free Audit', '[]'::jsonb, '', 'unconfigured', FALSE, NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `;
      await client.query(storeQuery, [storeId, workspace.id, `${workspace.name} Store`, '']);

      return { workspace, membership };
    });
  }

  async getWorkspaceById(workspaceId: string): Promise<WorkspaceRecord | null> {
    const query = `
      SELECT id, name, slug, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM workspaces
      WHERE id = $1
      LIMIT 1
    `;
    const res = await this.query(query, [workspaceId]);
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
    const res = await this.query(query, [userId]);
    return res.rows;
  }

  async getMembership(workspaceId: string, userId: string): Promise<WorkspaceMembershipRecord | null> {
    const query = `
      SELECT id, workspace_id AS "workspaceId", user_id AS "userId", role, created_at AS "createdAt"
      FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2
      LIMIT 1
    `;
    const res = await this.query(query, [workspaceId, userId]);
    return res.rows[0] || null;
  }

  async createSession(data: CreateSessionData): Promise<SessionRecord> {
    const query = `
      INSERT INTO sessions (id, session_token_hash, user_id, active_workspace_id, expires_at, created_at, last_active_at, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), $6, $7)
      RETURNING id, session_token_hash AS "sessionTokenHash", user_id AS "userId", active_workspace_id AS "activeWorkspaceId", expires_at AS "expiresAt", created_at AS "createdAt", last_active_at AS "lastActiveAt", ip_address AS "ipAddress", user_agent AS "userAgent"
    `;
    const res = await this.query(query, [
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
    const res = await this.query(query, [tokenHash]);
    return res.rows[0] || null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.query('DELETE FROM sessions WHERE session_token_hash = $1', [tokenHash]);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }

  async updateSessionWorkspace(sessionId: string, newWorkspaceId: string): Promise<void> {
    await this.query(
      'UPDATE sessions SET active_workspace_id = $1, last_active_at = NOW() WHERE id = $2',
      [newWorkspaceId, sessionId]
    );
  }

  async getStoreByWorkspace(workspaceId: string): Promise<StoreProfile | null> {
    const query = `
      SELECT id, name, domain, website_url AS "websiteUrl", platform, source_classification AS "sourceClassification", source_metadata_json AS "sourceMetadataJson", evidence_coverage_avg AS "evidenceCoverageAvg", last_audit_date AS "lastAuditDate", shopify_connected AS "shopifyConnected", shopify_shop_domain AS "shopifyShopDomain", currency, sku_count AS "skuCount", sku_limit AS "skuLimit", catalog_completeness_avg AS "catalogCompletenessAvg", truth_boundary_strictness AS "truthBoundaryStrictness", tier, connectors_json AS "connectorsJson"
      FROM stores
      WHERE workspace_id = $1
      LIMIT 1
    `;
    const res = await this.query(query, [workspaceId]);
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    const parsedLimit = (typeof r.skuLimit === 'number' && !isNaN(r.skuLimit)) ? r.skuLimit : undefined;
    const parsedEvidenceAvg = (typeof r.evidenceCoverageAvg === 'number' && !isNaN(r.evidenceCoverageAvg)) ? r.evidenceCoverageAvg : undefined;
    const parsedSourceMetadata = r.sourceMetadataJson
      ? (typeof r.sourceMetadataJson === 'string' ? JSON.parse(r.sourceMetadataJson) : r.sourceMetadataJson)
      : undefined;
    const shopifyConnected = Boolean(r.shopifyConnected);
    const domain = r.domain ?? '';
    return {
      name: r.name,
      domain,
      websiteUrl: r.websiteUrl ?? domain,
      platform: r.platform || undefined,
      sourceClassification: r.sourceClassification || (shopifyConnected ? 'shopify_oauth' : 'unconfigured'),
      ...(parsedSourceMetadata && Object.keys(parsedSourceMetadata).length > 0 ? { sourceMetadata: parsedSourceMetadata } : {}),
      shopifyConnected,
      ...(r.shopifyShopDomain ? { shopifyShopDomain: r.shopifyShopDomain } : {}),
      skuCount: r.skuCount,
      skuLimit: parsedLimit,
      tier: r.tier,
      ...(r.lastAuditDate ? { lastAuditDate: r.lastAuditDate } : {}),
      currency: r.currency,
      connectors: typeof r.connectorsJson === 'string' ? JSON.parse(r.connectorsJson) : (r.connectorsJson || []),
      catalogCompletenessAvg: r.catalogCompletenessAvg,
      ...(parsedEvidenceAvg !== undefined ? { evidenceCoverageAvg: parsedEvidenceAvg } : {}),
      truthBoundaryStrictness: r.truthBoundaryStrictness,
    };
  }

  async saveStoreProfile(workspaceId: string, profile: StoreProfile): Promise<StoreProfile> {
    return this.saveStoreProfileWithClient(
      { query: (text: string, params?: any[]) => this.query(text, params) },
      workspaceId,
      profile
    );
  }

  private async saveStoreProfileWithClient(
    queryable: { query: (text: string, params?: any[]) => Promise<any> },
    workspaceId: string,
    profile: StoreProfile
  ): Promise<StoreProfile> {
    const storeId = `store_${workspaceId}`;
    const cleanSkuLimit = (typeof profile.skuLimit === 'number' && Number.isInteger(profile.skuLimit) && profile.skuLimit >= 0)
      ? profile.skuLimit
      : null;
    const cleanEvidenceAvg = (typeof profile.evidenceCoverageAvg === 'number' && !isNaN(profile.evidenceCoverageAvg))
      ? Math.round(profile.evidenceCoverageAvg)
      : null;
    const cleanDomain = profile.domain ?? '';
    const cleanWebsiteUrl = profile.websiteUrl ?? cleanDomain;
    const cleanShopifyConnected = Boolean(profile.shopifyConnected);
    const cleanClassification = profile.sourceClassification || (cleanShopifyConnected ? 'shopify_oauth' : 'unconfigured');
    const query = `
      INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, sku_limit, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json, website_url, platform, source_classification, source_metadata_json, evidence_coverage_avg, last_audit_date, shopify_connected, shopify_shop_domain, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15::jsonb, $16, $17, $18, $19, NOW(), NOW())
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
        website_url = EXCLUDED.website_url,
        platform = EXCLUDED.platform,
        source_classification = EXCLUDED.source_classification,
        source_metadata_json = EXCLUDED.source_metadata_json,
        evidence_coverage_avg = EXCLUDED.evidence_coverage_avg,
        last_audit_date = EXCLUDED.last_audit_date,
        shopify_connected = EXCLUDED.shopify_connected,
        shopify_shop_domain = EXCLUDED.shopify_shop_domain,
        updated_at = NOW()
      RETURNING name, domain, website_url AS "websiteUrl", platform, source_classification AS "sourceClassification", source_metadata_json AS "sourceMetadataJson", evidence_coverage_avg AS "evidenceCoverageAvg", last_audit_date AS "lastAuditDate", shopify_connected AS "shopifyConnected", shopify_shop_domain AS "shopifyShopDomain", currency, sku_count AS "skuCount", sku_limit AS "skuLimit", catalog_completeness_avg AS "catalogCompletenessAvg", truth_boundary_strictness AS "truthBoundaryStrictness", tier, connectors_json AS "connectorsJson"
    `;
    const res = await queryable.query(query, [
      storeId,
      workspaceId,
      profile.name,
      cleanDomain,
      profile.currency,
      profile.skuCount,
      cleanSkuLimit,
      profile.catalogCompletenessAvg,
      profile.truthBoundaryStrictness,
      profile.tier,
      JSON.stringify(profile.connectors || []),
      cleanWebsiteUrl,
      profile.platform ?? null,
      cleanClassification,
      JSON.stringify(profile.sourceMetadata || {}),
      cleanEvidenceAvg,
      profile.lastAuditDate ?? null,
      cleanShopifyConnected,
      profile.shopifyShopDomain ?? null,
    ]);
    const r = res.rows[0];
    const parsedEvidenceAvg = (typeof r.evidenceCoverageAvg === 'number' && !isNaN(r.evidenceCoverageAvg))
      ? r.evidenceCoverageAvg
      : profile.evidenceCoverageAvg;
    const parsedMeta = r.sourceMetadataJson
      ? (typeof r.sourceMetadataJson === 'string' ? JSON.parse(r.sourceMetadataJson) : r.sourceMetadataJson)
      : profile.sourceMetadata;
    const returnedShopifyConnected = r.shopifyConnected !== undefined ? Boolean(r.shopifyConnected) : cleanShopifyConnected;
    const returnedDomain = r.domain ?? cleanDomain;
    return {
      name: r.name,
      domain: returnedDomain,
      websiteUrl: r.websiteUrl ?? cleanWebsiteUrl,
      platform: r.platform ?? profile.platform ?? undefined,
      sourceClassification: r.sourceClassification ?? cleanClassification,
      ...(parsedMeta && Object.keys(parsedMeta).length > 0 ? { sourceMetadata: parsedMeta } : {}),
      shopifyConnected: returnedShopifyConnected,
      ...(r.shopifyShopDomain ?? profile.shopifyShopDomain ? { shopifyShopDomain: r.shopifyShopDomain ?? profile.shopifyShopDomain } : {}),
      skuCount: r.skuCount,
      skuLimit: (typeof r.skuLimit === 'number' && !isNaN(r.skuLimit)) ? r.skuLimit : undefined,
      tier: r.tier,
      ...((r.lastAuditDate ?? profile.lastAuditDate) ? { lastAuditDate: r.lastAuditDate ?? profile.lastAuditDate } : {}),
      currency: r.currency,
      connectors: typeof r.connectorsJson === 'string' ? JSON.parse(r.connectorsJson) : (r.connectorsJson || []),
      catalogCompletenessAvg: r.catalogCompletenessAvg,
      ...(parsedEvidenceAvg !== undefined ? { evidenceCoverageAvg: parsedEvidenceAvg } : {}),
      truthBoundaryStrictness: r.truthBoundaryStrictness,
    };
  }

  private async loadCatalogRows(
    queryable: { query: (text: string, params?: any[]) => Promise<any> },
    workspaceId: string,
    store: StoreProfile
  ): Promise<StoragePayloadV1> {
    const prodRes = await queryable.query(
      `SELECT id, title, brand, category, description, image, status, completeness_score AS "completenessScore", evidence_coverage_score AS "evidenceCoverageScore", external_discovery_status AS "externalDiscoveryStatus", source_classification AS "sourceClassification", source_origin AS "sourceOrigin", acquisition_method AS "acquisitionMethod", attributes_json AS "attributesJson", findings_count AS "findingsCount", last_audited AS "lastAudited"
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
      `SELECT
        id,
        product_id AS "productId",
        title,
        type,
        issuer,
        date_verified AS "dateVerified",
        url,
        status,
        evidence_purpose AS "evidencePurpose",
        verification_source AS "verificationSource",
        external_verification_status AS "externalVerificationStatus",
        submitted_by_user_id AS "submittedByUserId",
        reviewed_by AS "verifiedBy",
        reviewer_principal_type AS "reviewerPrincipalType",
        reviewer_auth_method AS "reviewerAuthMethod",
        reviewed_at AS "reviewedAt",
        decision,
        decision_reason AS "decisionReason",
        external_provider_name AS "externalProviderName",
        external_provider_ref AS "externalProviderRef",
        external_request_at AS "externalRequestAt",
        external_response_at AS "externalResponseAt",
        external_verification_result AS "externalVerificationResult",
        external_verification_evidence_json AS "externalVerificationEvidence",
        integrity_hash AS "integrityHash",
        created_at AS "createdAt"
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
        url: r.url || undefined,
        status: r.status,
        evidencePurpose: r.evidencePurpose || 'general',
        verificationSource: r.verificationSource || 'client_submission',
        externalVerificationStatus: r.externalVerificationStatus || 'not_externally_verified',
        ...(r.submittedByUserId ? { submittedByUserId: r.submittedByUserId } : {}),
        ...(r.verifiedBy ? { verifiedBy: r.verifiedBy } : {}),
        ...(r.reviewerPrincipalType ? { reviewerPrincipalType: r.reviewerPrincipalType } : {}),
        ...(r.reviewerAuthMethod ? { reviewerAuthMethod: r.reviewerAuthMethod } : {}),
        ...(r.reviewedAt ? { reviewedAt: new Date(r.reviewedAt).toISOString() } : {}),
        ...(r.decision ? { decision: r.decision } : {}),
        ...(r.decisionReason ? { decisionReason: r.decisionReason } : {}),
        ...(r.externalProviderName ? { externalProviderName: r.externalProviderName } : {}),
        ...(r.externalProviderRef ? { externalProviderRef: r.externalProviderRef } : {}),
        ...(r.externalRequestAt ? { externalRequestAt: new Date(r.externalRequestAt).toISOString() } : {}),
        ...(r.externalResponseAt ? { externalResponseAt: new Date(r.externalResponseAt).toISOString() } : {}),
        ...(r.externalVerificationResult ? { externalVerificationResult: r.externalVerificationResult } : {}),
        ...(r.externalVerificationEvidence
          ? {
              externalVerificationEvidence:
                typeof r.externalVerificationEvidence === 'string'
                  ? JSON.parse(r.externalVerificationEvidence)
                  : r.externalVerificationEvidence,
            }
          : {}),
        ...(r.integrityHash ? { integrityHash: r.integrityHash } : {}),
        ...(r.createdAt ? { createdAt: new Date(r.createdAt).toISOString() } : {}),
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
      ...(r.sourceClassification ? { sourceClassification: r.sourceClassification } : {}),
      ...(r.sourceOrigin ? { sourceOrigin: r.sourceOrigin } : {}),
      ...(r.acquisitionMethod ? { acquisitionMethod: r.acquisitionMethod } : {}),
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
  ): Promise<number> {
    const authoritativeSkuCount = countCatalogSkus(payload.products);
    authoritativeStore.skuCount = authoritativeSkuCount;
    if (payload.storeProfile) {
      payload.storeProfile.skuCount = authoritativeSkuCount;
    }

    const resolvedDomain = payload.storeProfile?.domain !== undefined ? payload.storeProfile.domain : authoritativeStore.domain;
    const resolvedWebsiteUrl = payload.storeProfile?.websiteUrl !== undefined ? payload.storeProfile.websiteUrl : (authoritativeStore.websiteUrl ?? resolvedDomain);
    const resolvedShopifyConnected = payload.storeProfile?.shopifyConnected !== undefined ? Boolean(payload.storeProfile.shopifyConnected) : Boolean(authoritativeStore.shopifyConnected);
    const resolvedShopifyShopDomain = payload.storeProfile?.shopifyShopDomain ?? authoritativeStore.shopifyShopDomain ?? null;
    const resolvedPlatform = payload.storeProfile?.platform ?? authoritativeStore.platform ?? null;
    const resolvedSourceClass = payload.storeProfile?.sourceClassification ?? authoritativeStore.sourceClassification ?? (resolvedShopifyConnected ? 'shopify_oauth' : 'unconfigured');
    const resolvedSourceMeta = payload.storeProfile?.sourceMetadata ?? authoritativeStore.sourceMetadata ?? {};
    const resolvedEvidenceAvg = payload.storeProfile?.evidenceCoverageAvg !== undefined
      ? payload.storeProfile.evidenceCoverageAvg
      : authoritativeStore.evidenceCoverageAvg;
    const cleanEvidenceAvg = (typeof resolvedEvidenceAvg === 'number' && !isNaN(resolvedEvidenceAvg))
      ? Math.round(resolvedEvidenceAvg)
      : null;
    const resolvedLastAudit = payload.storeProfile?.lastAuditDate ?? authoritativeStore.lastAuditDate ?? null;

    // Update store profile, preserving server-managed tier and sku_limit, and advance catalog_version
    const storeUpsertRes = await client.query<{ catalog_version?: number }>(
      `INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, tier, sku_limit, connectors_json, website_url, platform, source_classification, source_metadata_json, evidence_coverage_avg, last_audit_date, shopify_connected, shopify_shop_domain, catalog_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15::jsonb, $16, $17, $18, $19, 1, NOW(), NOW())
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
         website_url = EXCLUDED.website_url,
         platform = EXCLUDED.platform,
         source_classification = EXCLUDED.source_classification,
         source_metadata_json = EXCLUDED.source_metadata_json,
         evidence_coverage_avg = EXCLUDED.evidence_coverage_avg,
         last_audit_date = EXCLUDED.last_audit_date,
         shopify_connected = EXCLUDED.shopify_connected,
         shopify_shop_domain = EXCLUDED.shopify_shop_domain,
         catalog_version = COALESCE(stores.catalog_version, 1) + 1,
         updated_at = NOW()
       RETURNING catalog_version`,
      [
        storeId,
        workspaceId,
        payload.storeProfile?.name || authoritativeStore.name,
        resolvedDomain ?? '',
        payload.storeProfile?.currency || authoritativeStore.currency,
        authoritativeSkuCount,
        payload.storeProfile?.catalogCompletenessAvg ?? authoritativeStore.catalogCompletenessAvg ?? 0,
        payload.storeProfile?.truthBoundaryStrictness || authoritativeStore.truthBoundaryStrictness,
        authoritativeStore.tier,
        authoritativeStore.skuLimit !== undefined ? authoritativeStore.skuLimit : null,
        JSON.stringify(payload.storeProfile?.connectors || authoritativeStore.connectors || []),
        resolvedWebsiteUrl ?? '',
        resolvedPlatform,
        resolvedSourceClass,
        JSON.stringify(resolvedSourceMeta),
        cleanEvidenceAvg,
        resolvedLastAudit,
        resolvedShopifyConnected,
        resolvedShopifyShopDomain,
      ]
    );
    const nextVersion = Number(storeUpsertRes.rows[0]?.catalog_version ?? 1);
    payload.catalogVersion = nextVersion;

    // Prune Shopify provenance rows only for products explicitly removed from the catalog
    const activeProductIds = (payload.products || []).map(p => p.id);
    if (activeProductIds.length === 0) {
      await client.query('DELETE FROM shopify_product_provenance WHERE workspace_id = $1', [workspaceId]);
    } else {
      await client.query(
        'DELETE FROM shopify_product_provenance WHERE workspace_id = $1 AND NOT (product_id = ANY($2::text[]))',
        [workspaceId, activeProductIds]
      );
    }

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
        `INSERT INTO products (id, workspace_id, store_id, title, brand, category, description, image, status, completeness_score, evidence_coverage_score, external_discovery_status, attributes_json, findings_count, last_audited, source_classification, source_origin, acquisition_method, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, NOW(), NOW())`,
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
          p.sourceClassification ?? null,
          p.sourceOrigin ?? null,
          p.acquisitionMethod ?? null,
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

      // Insert evidence with full server provenance columns
      for (const e of p.evidenceDocuments || []) {
        await client.query(
          `INSERT INTO evidence_documents (
             id, workspace_id, product_id, title, type, issuer, date_verified, url, status,
             evidence_purpose, verification_source, external_verification_status,
             submitted_by_user_id, reviewed_by, reviewer_principal_type, reviewer_auth_method,
             reviewed_at, decision, decision_reason,
             external_provider_name, external_provider_ref, external_request_at, external_response_at,
             external_verification_result, external_verification_evidence_json,
             integrity_hash, created_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12,
             $13, $14, $15, $16,
             $17, $18, $19,
             $20, $21, $22, $23,
             $24, $25::jsonb,
             $26, COALESCE($27::timestamptz, NOW())
           )`,
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
            e.evidencePurpose || 'general',
            e.verificationSource || 'client_submission',
            e.externalVerificationStatus || 'not_externally_verified',
            e.submittedByUserId || null,
            e.verifiedBy || null,
            e.reviewerPrincipalType || null,
            e.reviewerAuthMethod || null,
            e.reviewedAt || null,
            e.decision || 'pending',
            e.decisionReason || null,
            e.externalProviderName || null,
            e.externalProviderRef || null,
            e.externalRequestAt || null,
            e.externalResponseAt || null,
            e.externalVerificationResult || null,
            e.externalVerificationEvidence ? JSON.stringify(e.externalVerificationEvidence) : null,
            e.integrityHash || null,
            e.createdAt || null,
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

    return nextVersion;
  }

  async withWorkspaceLock<T>(
    workspaceId: string,
    fn: () => Promise<T>,
    options: { lockTimeoutMs?: number } = {}
  ): Promise<T> {
    const lockTimeoutMs = Math.max(250, options.lockTimeoutMs ?? 30_000);
    const deadline = Date.now() + lockTimeoutMs;

    const existingCtx = this.lockStorage.getStore();
    if (existingCtx) {
      if (existingCtx.heldWorkspaceLocks.has(workspaceId)) {
        return await fn();
      }

      // Prevent cross-workspace lock-order inversion deadlocks by enforcing deterministic lexicographical acquisition order
      const held = Array.from(existingCtx.heldWorkspaceLocks).sort();
      const maxHeld = held[held.length - 1];
      if (maxHeld !== undefined && workspaceId < maxHeld) {
        throw new WorkspaceLockOrderError(held, workspaceId);
      }

      while (true) {
        let nestedLockAttempted = false;
        let nestedLockOutcomeKnown = false;
        let res: { rows: Array<{ locked: boolean }> };
        try {
          nestedLockAttempted = true;
          res = await existingCtx.client.query<{ locked: boolean }>(
            `SELECT pg_try_advisory_lock(hashtext('aixshop_ws'), hashtext($1)) AS locked`,
            [workspaceId]
          );
          nestedLockOutcomeKnown = true;
        } catch (acqErr) {
          if (nestedLockAttempted && !nestedLockOutcomeKnown) {
            existingCtx.poisoned = true;
            console.error(
              `[AIXSHOP Workspace Lock] Nested pg_try_advisory_lock failed with uncertain server lock state for workspace "${workspaceId}"; connection marked for destruction.`,
              acqErr
            );
          }
          throw acqErr;
        }

        if (res.rows[0]?.locked) {
          existingCtx.heldWorkspaceLocks.add(workspaceId);
          let operationResult: T;
          let operationError: unknown;
          let hasOperationError = false;
          try {
            operationResult = await fn();
          } catch (err) {
            operationError = err;
            hasOperationError = true;
          }

          existingCtx.heldWorkspaceLocks.delete(workspaceId);
          try {
            const unlockRes = await existingCtx.client.query<{ pg_advisory_unlock: boolean }>(
              `SELECT pg_advisory_unlock(hashtext('aixshop_ws'), hashtext($1)) AS pg_advisory_unlock`,
              [workspaceId]
            );
            if (unlockRes.rows[0] && unlockRes.rows[0].pg_advisory_unlock === false) {
              existingCtx.poisoned = true;
              console.error(
                `[AIXSHOP Workspace Lock] Nested pg_advisory_unlock returned false for workspace "${workspaceId}"; connection marked for destruction.`
              );
            }
          } catch (unlockErr) {
            existingCtx.poisoned = true;
            console.error(
              `[AIXSHOP Workspace Lock] Failed to release nested PostgreSQL advisory lock for workspace "${workspaceId}"; connection marked for destruction:`,
              unlockErr
            );
          }

          if (hasOperationError) {
            throw operationError;
          }
          return operationResult!;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `[AIXSHOP Workspace Lock] Timed out after ${lockTimeoutMs}ms waiting for distributed PostgreSQL lock on workspace "${workspaceId}".`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    while (true) {
      const client = await this.pool.connect();
      let lockAttempted = false;
      let lockOutcomeKnown = false;
      let lockAcquiredNow = false;
      let released = false;
      const releaseOnce = (destroy: boolean) => {
        if (released) return;
        released = true;
        try {
          if (destroy) {
            (client.release as any)(true);
          } else {
            client.release();
          }
        } catch {
          // ignore secondary release errors
        }
      };

      try {
        lockAttempted = true;
        const res = await client.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext('aixshop_ws'), hashtext($1)) AS locked`,
          [workspaceId]
        );
        lockOutcomeKnown = true;
        lockAcquiredNow = Boolean(res.rows[0]?.locked);
        if (!lockAcquiredNow) {
          // Release connection immediately before backing off so waiters cannot exhaust the pool
          releaseOnce(false);
        } else {
          const lockCtx: WorkspaceLockContext = {
            client,
            heldWorkspaceLocks: new Set([workspaceId]),
            inTransaction: false,
            savepointDepth: 0,
            poisoned: false,
          };
          let destroyClient = false;
          try {
            return await this.lockStorage.run(lockCtx, fn);
          } finally {
            if (lockCtx.poisoned) {
              destroyClient = true;
            }
            try {
              const unlockRes = await client.query<{ pg_advisory_unlock: boolean }>(
                `SELECT pg_advisory_unlock(hashtext('aixshop_ws'), hashtext($1)) AS pg_advisory_unlock`,
                [workspaceId]
              );
              if (unlockRes.rows[0] && unlockRes.rows[0].pg_advisory_unlock === false) {
                destroyClient = true;
              }
            } catch {
              destroyClient = true;
            }
            releaseOnce(destroyClient || lockCtx.poisoned);
          }
        }
      } catch (err) {
        if (!lockAcquiredNow) {
          const lockStateUncertain = lockAttempted && !lockOutcomeKnown;
          if (lockStateUncertain) {
            console.error(
              `[AIXSHOP Workspace Lock] Outer pg_try_advisory_lock failed with uncertain server lock state for workspace "${workspaceId}"; destroying connection.`,
              err
            );
          }
          releaseOnce(lockStateUncertain);
        }
        throw err;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `[AIXSHOP Workspace Lock] Timed out after ${lockTimeoutMs}ms waiting for distributed PostgreSQL lock on workspace "${workspaceId}".`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async loadWorkspaceCatalog(workspaceId: string): Promise<StoragePayloadV1 | null> {
    const store = await this.getStoreByWorkspace(workspaceId);
    if (!store) return null;
    const queryable = this.getActiveClient() || this.pool;
    const catalog = await this.loadCatalogRows(queryable, workspaceId, store);
    try {
      const verRes = await this.query<{ catalog_version: number }>(
        'SELECT catalog_version FROM stores WHERE workspace_id = $1 LIMIT 1',
        [workspaceId]
      );
      if (verRes.rows[0]?.catalog_version !== undefined) {
        catalog.catalogVersion = Number(verRes.rows[0].catalog_version);
      }
    } catch {
      // Ignore on minimal mocks or pre-012 tables
    }
    return catalog;
  }

  async saveWorkspaceCatalog(
    workspaceId: string,
    payload: StoragePayloadV1,
    options?: { expectedVersion?: number }
  ): Promise<void> {
    return this.withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('aixshop_cat'), hashtext($1))`, [workspaceId]);
      const storeId = `store_${workspaceId}`;

      // 1. Consistent lock order: Acquire row-level lock on stores table
      let storeRes = await client.query<{
        id: string;
        tier: string;
        sku_limit: number | null;
        name: string;
        domain: string;
        website_url?: string;
        platform?: string | null;
        source_classification?: any;
        source_metadata_json?: any;
        evidence_coverage_avg?: number | null;
        last_audit_date?: string | null;
        shopify_connected?: boolean;
        shopify_shop_domain?: string | null;
        currency: string;
        sku_count: number;
        catalog_completeness_avg: number;
        truth_boundary_strictness: string;
        connectors_json: any;
        catalog_version?: number;
      }>(
        `SELECT id, tier, sku_limit, name, domain, website_url, platform, source_classification, source_metadata_json, evidence_coverage_avg, last_audit_date, shopify_connected, shopify_shop_domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json, catalog_version
         FROM stores
         WHERE workspace_id = $1
         FOR UPDATE`,
        [workspaceId]
      );

      if (storeRes.rows.length === 0) {
        await client.query(
          `INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json, website_url, source_classification, shopify_connected, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 0, 0, 'standard', 'Free Audit', '[]'::jsonb, '', 'unconfigured', FALSE, NOW(), NOW())
           ON CONFLICT (id) DO NOTHING`,
          [storeId, workspaceId, payload.storeProfile?.name || `${workspaceId} Store`, '']
        );
        storeRes = await client.query(
          `SELECT id, tier, sku_limit, name, domain, website_url, platform, source_classification, source_metadata_json, evidence_coverage_avg, last_audit_date, shopify_connected, shopify_shop_domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json, catalog_version
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
        domain: payload.storeProfile?.domain ?? '',
        website_url: payload.storeProfile?.websiteUrl ?? payload.storeProfile?.domain ?? '',
        platform: payload.storeProfile?.platform ?? null,
        source_classification: 'unconfigured',
        source_metadata_json: '{}',
        evidence_coverage_avg: null,
        last_audit_date: null,
        shopify_connected: false,
        shopify_shop_domain: null,
        currency: payload.storeProfile?.currency || 'USD',
        sku_count: 0,
        catalog_completeness_avg: 0,
        truth_boundary_strictness: 'standard',
        connectors_json: '[]',
        catalog_version: 1,
      };

      const currentVersion = Number(lockedRow.catalog_version ?? 1);
      const rawExpected = options?.expectedVersion !== undefined ? options.expectedVersion : payload.catalogVersion;

      if (rawExpected !== undefined) {
        if (typeof rawExpected !== 'number' || !Number.isInteger(rawExpected) || rawExpected < 1) {
          throw new CatalogVersionValidationError(
            'Invalid catalog expectedVersion: must be a positive integer (>= 1).',
            currentVersion
          );
        }
        if (rawExpected !== currentVersion) {
          throw new CatalogVersionConflictError(workspaceId, rawExpected, currentVersion);
        }
      } else {
        // Missing expectedVersion is only permitted once when initializing an empty/uninitialized catalog
        let hasExistingItems = Number(lockedRow.sku_count || 0) > 0 || currentVersion > 1;
        if (!hasExistingItems) {
          const existsRes = await client.query<{
            has_products: boolean;
            has_findings: boolean;
            has_actions: boolean;
          }>(
            `SELECT
               EXISTS(SELECT 1 FROM products WHERE workspace_id = $1) AS has_products,
               EXISTS(SELECT 1 FROM findings WHERE workspace_id = $1) AS has_findings,
               EXISTS(SELECT 1 FROM action_items WHERE workspace_id = $1) AS has_actions`,
            [workspaceId]
          );
          const row = existsRes.rows[0];
          if (row && (row.has_products || row.has_findings || row.has_actions)) {
            hasExistingItems = true;
          }
        }
        if (hasExistingItems) {
          throw new CatalogVersionConflictError(workspaceId, null, currentVersion);
        }
      }

      const lockedDomain = lockedRow.domain ?? payload.storeProfile?.domain ?? '';
      const lockedMeta = lockedRow.source_metadata_json
        ? (typeof lockedRow.source_metadata_json === 'string' ? JSON.parse(lockedRow.source_metadata_json) : lockedRow.source_metadata_json)
        : undefined;
      const authoritativeStore: StoreProfile = {
        name: lockedRow.name || payload.storeProfile?.name || 'Store',
        domain: lockedDomain,
        websiteUrl: lockedRow.website_url ?? lockedDomain,
        ...(lockedRow.platform ? { platform: lockedRow.platform } : {}),
        sourceClassification: lockedRow.source_classification || (lockedRow.shopify_connected ? 'shopify_oauth' : 'unconfigured'),
        ...(lockedMeta && Object.keys(lockedMeta).length > 0 ? { sourceMetadata: lockedMeta } : {}),
        shopifyConnected: Boolean(lockedRow.shopify_connected),
        ...(lockedRow.shopify_shop_domain ? { shopifyShopDomain: lockedRow.shopify_shop_domain } : {}),
        currency: lockedRow.currency || payload.storeProfile?.currency || 'USD',
        skuCount: lockedRow.sku_count || 0,
        catalogCompletenessAvg: lockedRow.catalog_completeness_avg || 0,
        ...(typeof lockedRow.evidence_coverage_avg === 'number' && !isNaN(lockedRow.evidence_coverage_avg)
          ? { evidenceCoverageAvg: lockedRow.evidence_coverage_avg }
          : {}),
        ...(lockedRow.last_audit_date ? { lastAuditDate: lockedRow.last_audit_date } : {}),
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
    });
  }

  private async lockStoreAndLoadCatalogForUpdate(
    client: PoolClient,
    workspaceId: string,
    options: { createStoreIfMissing?: boolean } = {}
  ): Promise<{ storeId: string; authoritativeStore: StoreProfile; catalog: StoragePayloadV1 }> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('aixshop_cat'), hashtext($1))`, [workspaceId]);
    const storeId = `store_${workspaceId}`;

    // 1. Consistent lock order: Acquire row-level lock on stores table first
    let storeRes = await client.query<{
      id: string;
      tier: string;
      sku_limit: number | null;
      name: string;
      domain: string;
      website_url?: string;
      platform?: string | null;
      source_classification?: any;
      source_metadata_json?: any;
      evidence_coverage_avg?: number | null;
      last_audit_date?: string | null;
      shopify_connected?: boolean;
      shopify_shop_domain?: string | null;
      currency: string;
      sku_count: number;
      catalog_completeness_avg: number;
      truth_boundary_strictness: string;
      connectors_json: any;
      catalog_version?: number;
    }>(
      `SELECT id, tier, sku_limit, name, domain, website_url, platform, source_classification, source_metadata_json, evidence_coverage_avg, last_audit_date, shopify_connected, shopify_shop_domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json, catalog_version
       FROM stores
       WHERE workspace_id = $1
       FOR UPDATE`,
      [workspaceId]
    );

    if (storeRes.rows.length === 0 && options.createStoreIfMissing) {
      await client.query(
        `INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json, website_url, source_classification, shopify_connected, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, 0, 'standard', 'Free Audit', '[]'::jsonb, '', 'unconfigured', FALSE, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [storeId, workspaceId, `${workspaceId} Store`, '', 'USD']
      );
      storeRes = await client.query(
        `SELECT id, tier, sku_limit, name, domain, website_url, platform, source_classification, source_metadata_json, evidence_coverage_avg, last_audit_date, shopify_connected, shopify_shop_domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json, catalog_version
         FROM stores
         WHERE workspace_id = $1
         FOR UPDATE`,
        [workspaceId]
      );
    }

    if (storeRes.rows.length === 0) {
      throw new Error(`Workspace ${workspaceId} catalog not found`);
    }

    const lockedRow = storeRes.rows[0];
    const lockedDomain = lockedRow.domain ?? '';
    const lockedMeta = lockedRow.source_metadata_json
      ? (typeof lockedRow.source_metadata_json === 'string' ? JSON.parse(lockedRow.source_metadata_json) : lockedRow.source_metadata_json)
      : undefined;
    const authoritativeStore: StoreProfile = {
      name: lockedRow.name || 'Store',
      domain: lockedDomain,
      websiteUrl: lockedRow.website_url ?? lockedDomain,
      ...(lockedRow.platform ? { platform: lockedRow.platform } : {}),
      sourceClassification: lockedRow.source_classification || (lockedRow.shopify_connected ? 'shopify_oauth' : 'unconfigured'),
      ...(lockedMeta && Object.keys(lockedMeta).length > 0 ? { sourceMetadata: lockedMeta } : {}),
      shopifyConnected: Boolean(lockedRow.shopify_connected),
      ...(lockedRow.shopify_shop_domain ? { shopifyShopDomain: lockedRow.shopify_shop_domain } : {}),
      currency: lockedRow.currency || 'USD',
      skuCount: lockedRow.sku_count || 0,
      catalogCompletenessAvg: lockedRow.catalog_completeness_avg || 0,
      ...(typeof lockedRow.evidence_coverage_avg === 'number' && !isNaN(lockedRow.evidence_coverage_avg)
        ? { evidenceCoverageAvg: lockedRow.evidence_coverage_avg }
        : {}),
      ...(lockedRow.last_audit_date ? { lastAuditDate: lockedRow.last_audit_date } : {}),
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
    if (lockedRow.catalog_version !== undefined) {
      catalog.catalogVersion = Number(lockedRow.catalog_version);
    }

    return { storeId, authoritativeStore, catalog };
  }

  private async mutateCatalogUnderLock<T>(
    workspaceId: string,
    mutator: (
      catalog: StoragePayloadV1,
      authoritativeStore: StoreProfile
    ) => Promise<{ nextCatalog?: StoragePayloadV1; result: T }> | { nextCatalog?: StoragePayloadV1; result: T },
    options: { createStoreIfMissing?: boolean } = {}
  ): Promise<{ result: T; catalogVersion?: number }> {
    return this.withTransaction(async (client) => {
      const { storeId, authoritativeStore, catalog } = await this.lockStoreAndLoadCatalogForUpdate(
        client,
        workspaceId,
        options
      );

      // 3. Apply the requested mutation to the latest authoritative state
      const { nextCatalog, result } = await mutator(catalog, authoritativeStore);

      let persistedVersion: number | undefined = catalog.catalogVersion;
      if (nextCatalog) {
        // 4. Validate quota under the lock
        const proposedSkus = countCatalogSkus(nextCatalog.products);
        const quotaCheck = checkPlanQuota(authoritativeStore, [], proposedSkus);
        if (!quotaCheck.allowed) {
          throw new PlanQuotaExceededError(quotaCheck);
        }

        // 5. Persist the updated catalog through transaction-aware helper reusing the same client
        persistedVersion = await this.saveCatalogRows(client, workspaceId, nextCatalog, storeId, authoritativeStore);
        nextCatalog.catalogVersion = persistedVersion;
      }

      return { result, catalogVersion: persistedVersion };
    });
  }

  async mutateWorkspaceCatalog<T>(
    workspaceId: string,
    mutator: (
      catalog: StoragePayloadV1,
      authoritativeStore: StoreProfile
    ) => Promise<{ nextCatalog?: StoragePayloadV1; result: T }> | { nextCatalog?: StoragePayloadV1; result: T }
  ): Promise<T> {
    const wrapped = await this.mutateCatalogUnderLock(workspaceId, mutator, { createStoreIfMissing: true });
    return wrapped.result;
  }

  async approveAction(
    workspaceId: string, 
    actionId: string, 
    customApprovedValue?: string
  ): Promise<{ action: ActionItem; product?: Product; catalogVersion?: number }> {
    const { result, catalogVersion } = await this.mutateCatalogUnderLock(workspaceId, (catalog, authoritativeStore) => {
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
    return { ...result, catalogVersion };
  }

  async dismissAction(workspaceId: string, actionId: string): Promise<{ action: ActionItem; catalogVersion?: number }> {
    const { result, catalogVersion } = await this.mutateCatalogUnderLock(workspaceId, (catalog, authoritativeStore) => {
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
    return { ...result, catalogVersion };
  }

  async recheckAction(workspaceId: string, actionId: string): Promise<{ action: ActionItem; catalogVersion?: number }> {
    const { result, catalogVersion } = await this.mutateCatalogUnderLock(workspaceId, (catalog, authoritativeStore) => {
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
    return { ...result, catalogVersion };
  }

  async importCatalog(
    workspaceId: string,
    candidates: any[]
  ): Promise<CatalogImportResult> {
    const safeCandidates = sanitizeAndValidateImportCandidates(workspaceId, candidates, {
      rejectOnTampering: true,
    });

    return this.withTransaction(async (client) => {
      const storeId = `store_${workspaceId}`;

      // 1. Consistent lock order: Acquire row-level lock on stores table
      let storeRes = await client.query<{
        id: string;
        tier: string;
        sku_limit: number | null;
        name: string;
        domain: string;
        website_url?: string;
        platform?: string | null;
        source_classification?: any;
        source_metadata_json?: any;
        evidence_coverage_avg?: number | null;
        last_audit_date?: string | null;
        shopify_connected?: boolean;
        shopify_shop_domain?: string | null;
        currency: string;
        sku_count: number;
        catalog_completeness_avg: number;
        truth_boundary_strictness: string;
        connectors_json: any;
      }>(
        `SELECT id, tier, sku_limit, name, domain, website_url, platform, source_classification, source_metadata_json, evidence_coverage_avg, last_audit_date, shopify_connected, shopify_shop_domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json
         FROM stores
         WHERE workspace_id = $1
         FOR UPDATE`,
        [workspaceId]
      );

      if (storeRes.rows.length === 0) {
        await client.query(
          `INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json, website_url, source_classification, shopify_connected, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 0, 0, 'standard', 'Free Audit', '[]'::jsonb, '', 'unconfigured', FALSE, NOW(), NOW())
           ON CONFLICT (id) DO NOTHING`,
          [storeId, workspaceId, `${workspaceId} Store`, '', 'USD']
        );
        storeRes = await client.query(
          `SELECT id, tier, sku_limit, name, domain, website_url, platform, source_classification, source_metadata_json, evidence_coverage_avg, last_audit_date, shopify_connected, shopify_shop_domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json
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
        domain: '',
        website_url: '',
        platform: null,
        source_classification: 'unconfigured',
        source_metadata_json: '{}',
        evidence_coverage_avg: null,
        last_audit_date: null,
        shopify_connected: false,
        shopify_shop_domain: null,
        currency: 'USD',
        sku_count: 0,
        catalog_completeness_avg: 0,
        truth_boundary_strictness: 'standard',
        connectors_json: '[]',
      };
      const lockedDomain = lockedRow.domain ?? '';
      const lockedMeta = lockedRow.source_metadata_json
        ? (typeof lockedRow.source_metadata_json === 'string' ? JSON.parse(lockedRow.source_metadata_json) : lockedRow.source_metadata_json)
        : undefined;
      const authoritativeStore: StoreProfile = {
        name: lockedRow.name || 'Store',
        domain: lockedDomain,
        websiteUrl: lockedRow.website_url ?? lockedDomain,
        ...(lockedRow.platform ? { platform: lockedRow.platform } : {}),
        sourceClassification: lockedRow.source_classification || (lockedRow.shopify_connected ? 'shopify_oauth' : 'unconfigured'),
        ...(lockedMeta && Object.keys(lockedMeta).length > 0 ? { sourceMetadata: lockedMeta } : {}),
        shopifyConnected: Boolean(lockedRow.shopify_connected),
        ...(lockedRow.shopify_shop_domain ? { shopifyShopDomain: lockedRow.shopify_shop_domain } : {}),
        currency: lockedRow.currency || 'USD',
        skuCount: lockedRow.sku_count || 0,
        catalogCompletenessAvg: lockedRow.catalog_completeness_avg || 0,
        ...(typeof lockedRow.evidence_coverage_avg === 'number' && !isNaN(lockedRow.evidence_coverage_avg)
          ? { evidenceCoverageAvg: lockedRow.evidence_coverage_avg }
          : {}),
        ...(lockedRow.last_audit_date ? { lastAuditDate: lockedRow.last_audit_date } : {}),
        truthBoundaryStrictness: (lockedRow.truth_boundary_strictness || 'standard') as any,
        tier: (lockedRow.tier || 'Free Audit') as any,
        skuLimit: lockedRow.sku_limit !== null ? lockedRow.sku_limit : undefined,
        connectors: typeof lockedRow.connectors_json === 'string' ? JSON.parse(lockedRow.connectors_json) : (lockedRow.connectors_json || []),
      };

      // 2. Load existing catalog inside the transaction on the same locked client
      const existingCatalog = await this.loadCatalogRows(client, workspaceId, authoritativeStore);

      // 3. Deduplicate and calculate additional usage under the lock
      const { additionalSkus } = calculateImportUsage(safeCandidates, existingCatalog.products);

      // 4. Authoritative server-side quota validation under the lock
      const quotaCheck = checkPlanQuota(authoritativeStore, existingCatalog.products, additionalSkus);
      if (!quotaCheck.allowed) {
        throw new PlanQuotaExceededError(quotaCheck);
      }

      // 5. Ingest domain candidates
      const importRes = executeCatalogImport(safeCandidates, {
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

      return importRes;
    });
  }

  // Billing & Subscriptions
  async getSubscriptionByWorkspace(workspaceId: string): Promise<SubscriptionRecord | null> {
    const res = await this.query<any>(
      `SELECT id, workspace_id AS "workspaceId", provider, customer_id AS "customerId", subscription_id AS "subscriptionId", tier, status, current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd", cancel_at_period_end AS "cancelAtPeriodEnd", last_event_created AS "lastEventCreated", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM subscriptions
       WHERE workspace_id = $1`,
      [workspaceId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async getSubscriptionBySubscriptionId(subscriptionId: string): Promise<SubscriptionRecord | null> {
    const res = await this.query<any>(
      `SELECT id, workspace_id AS "workspaceId", provider, customer_id AS "customerId", subscription_id AS "subscriptionId", tier, status, current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd", cancel_at_period_end AS "cancelAtPeriodEnd", last_event_created AS "lastEventCreated", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM subscriptions
       WHERE subscription_id = $1`,
      [subscriptionId]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async saveSubscription(subscription: SubscriptionRecord): Promise<SubscriptionRecord> {
    const res = await this.query<any>(
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

  private mapBillingEventRow(r: any): BillingEventRecord {
    return {
      ...r,
      leaseExpiresAt: r.leaseExpiresAt ? new Date(r.leaseExpiresAt).toISOString() : null,
      lastAttemptAt: r.lastAttemptAt ? new Date(r.lastAttemptAt).toISOString() : null,
      nextRetryAt: r.nextRetryAt ? new Date(r.nextRetryAt).toISOString() : null,
      processedAt: new Date(r.processedAt).toISOString(),
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : undefined,
    };
  }

  async getBillingEventById(eventId: string): Promise<BillingEventRecord | null> {
    const res = await this.query<any>(
      `SELECT id, provider, event_id AS "eventId", event_type AS "eventType", idempotency_key AS "idempotencyKey",
              payload_json AS "payload", status, lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
              attempt_count AS "attemptCount", last_error AS "lastError", last_attempt_at AS "lastAttemptAt",
              next_retry_at AS "nextRetryAt", processed_at AS "processedAt", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM billing_events
       WHERE event_id = $1`,
      [eventId]
    );
    if (res.rows.length === 0) return null;
    return this.mapBillingEventRow(res.rows[0]);
  }

  async saveBillingEvent(event: BillingEventRecord): Promise<void> {
    await this.query(
      `INSERT INTO billing_events (
         id, provider, event_id, event_type, idempotency_key, payload_json, status,
         lease_owner, lease_expires_at, attempt_count, last_error, last_attempt_at, next_retry_at,
         processed_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
       ON CONFLICT (provider, event_id) DO UPDATE SET
         status = EXCLUDED.status,
         payload_json = EXCLUDED.payload_json,
         lease_owner = EXCLUDED.lease_owner,
         lease_expires_at = EXCLUDED.lease_expires_at,
         attempt_count = EXCLUDED.attempt_count,
         last_error = EXCLUDED.last_error,
         last_attempt_at = EXCLUDED.last_attempt_at,
         next_retry_at = EXCLUDED.next_retry_at,
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
        event.lastError ?? null,
        event.lastAttemptAt ?? null,
        event.nextRetryAt ?? null,
        event.processedAt || new Date().toISOString(),
      ]
    );
  }

  async claimBillingEvent(
    event: BillingEventRecord,
    leaseOptions?: { leaseOwner?: string; leaseDurationMs?: number }
  ): Promise<{ claimed: boolean; event: BillingEventRecord | null; leaseOwner?: string }> {
    const leaseDurationMs = Math.max(50, leaseOptions?.leaseDurationMs ?? 5 * 60 * 1000);
    const leaseOwner = leaseOptions?.leaseOwner || `worker_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const res = await this.query<any>(
      `INSERT INTO billing_events (
         id, provider, event_id, event_type, idempotency_key, payload_json, status,
         lease_owner, lease_expires_at, attempt_count, last_attempt_at, next_retry_at,
         processed_at, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'processing', $7, clock_timestamp() + ($8 * INTERVAL '1 millisecond'), 1, clock_timestamp(), NULL, clock_timestamp(), clock_timestamp(), clock_timestamp())
       ON CONFLICT (provider, event_id) DO UPDATE SET
         status = 'processing',
         lease_owner = EXCLUDED.lease_owner,
         lease_expires_at = clock_timestamp() + ($8 * INTERVAL '1 millisecond'),
         attempt_count = COALESCE(billing_events.attempt_count, 0) + 1,
         last_attempt_at = clock_timestamp(),
         next_retry_at = NULL,
         payload_json = CASE WHEN EXCLUDED.payload_json <> '{}'::jsonb THEN EXCLUDED.payload_json ELSE billing_events.payload_json END,
         processed_at = clock_timestamp(),
         updated_at = clock_timestamp()
       WHERE billing_events.status = 'failed'
          OR (
            billing_events.status = 'processing' AND (
              (billing_events.lease_expires_at IS NOT NULL AND billing_events.lease_expires_at < clock_timestamp())
              OR (billing_events.lease_expires_at IS NULL AND billing_events.processed_at < clock_timestamp() - INTERVAL '5 minutes')
            )
          )
       RETURNING id, provider, event_id AS "eventId", event_type AS "eventType", idempotency_key AS "idempotencyKey",
                 payload_json AS "payload", status, lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
                 attempt_count AS "attemptCount", last_error AS "lastError", last_attempt_at AS "lastAttemptAt",
                 next_retry_at AS "nextRetryAt", processed_at AS "processedAt"`,
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
      return {
        claimed: true,
        leaseOwner,
        event: this.mapBillingEventRow(res.rows[0]),
      };
    }

    const existing = await this.getBillingEventById(event.eventId);
    return { claimed: false, event: existing };
  }

  async listRecoverableBillingEvents(options?: {
    maxAttempts?: number;
    limit?: number;
    provider?: string;
  }): Promise<BillingEventRecord[]> {
    const maxAttempts = Math.max(1, options?.maxAttempts ?? 5);
    const limit = Math.max(1, Math.min(500, options?.limit ?? 50));
    const providerFilter = options?.provider ? options.provider : null;

    const res = await this.query<any>(
      `SELECT id, provider, event_id AS "eventId", event_type AS "eventType", idempotency_key AS "idempotencyKey",
              payload_json AS "payload", status, lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
              attempt_count AS "attemptCount", last_error AS "lastError", last_attempt_at AS "lastAttemptAt",
              next_retry_at AS "nextRetryAt", processed_at AS "processedAt", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM billing_events
       WHERE ($1::text IS NULL OR provider = $1)
         AND COALESCE(attempt_count, 0) < $2
         AND (
           (
             status = 'processing' AND (
               (lease_expires_at IS NOT NULL AND lease_expires_at < clock_timestamp())
               OR (lease_expires_at IS NULL AND processed_at < clock_timestamp() - INTERVAL '5 minutes')
             )
           )
           OR (
             status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= clock_timestamp())
           )
         )
       ORDER BY COALESCE(next_retry_at, lease_expires_at, processed_at, created_at) ASC, created_at ASC
       LIMIT $3`,
      [providerFilter, maxAttempts, limit]
    );

    return res.rows.map(r => this.mapBillingEventRow(r));
  }

  async finalizeExpiredExhaustedBillingEvents(options?: {
    maxAttempts?: number;
    limit?: number;
    provider?: string;
    reason?: string;
  }): Promise<BillingEventRecord[]> {
    const maxAttempts = Math.max(1, options?.maxAttempts ?? 5);
    const limit = Math.max(1, Math.min(500, options?.limit ?? 50));
    const providerFilter = options?.provider ? options.provider : null;
    const reason = (
      options?.reason ||
      `Worker lease expired on final attempt (maxAttempts=${maxAttempts}) without completion; event finalized to permanently_failed for manual replay.`
    ).slice(0, 500);

    const res = await this.query<any>(
      `WITH candidates AS (
         SELECT id
         FROM billing_events
         WHERE ($1::text IS NULL OR provider = $1)
           AND status = 'processing'
           AND COALESCE(attempt_count, 0) >= $2
           AND (
             (lease_expires_at IS NOT NULL AND lease_expires_at < clock_timestamp())
             OR (lease_expires_at IS NULL AND processed_at < clock_timestamp() - INTERVAL '5 minutes')
           )
         ORDER BY COALESCE(lease_expires_at, processed_at, created_at) ASC, created_at ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE billing_events AS b
       SET status = 'permanently_failed',
           lease_expires_at = NULL,
           next_retry_at = NULL,
           last_error = CASE
             WHEN b.last_error IS NOT NULL AND btrim(b.last_error) <> ''
               THEN LEFT(b.last_error || ' | ' || $4, 500)
             ELSE $4
           END,
           updated_at = clock_timestamp()
       FROM candidates AS c
       WHERE b.id = c.id
         AND b.status = 'processing'
       RETURNING b.id, b.provider, b.event_id AS "eventId", b.event_type AS "eventType",
                 b.idempotency_key AS "idempotencyKey", b.payload_json AS "payload",
                 b.status, b.lease_owner AS "leaseOwner", b.lease_expires_at AS "leaseExpiresAt",
                 b.attempt_count AS "attemptCount", b.last_error AS "lastError",
                 b.last_attempt_at AS "lastAttemptAt", b.next_retry_at AS "nextRetryAt",
                 b.processed_at AS "processedAt", b.created_at AS "createdAt", b.updated_at AS "updatedAt"`,
      [providerFilter, maxAttempts, limit, reason]
    );

    return res.rows.map(r => this.mapBillingEventRow(r));
  }

  async claimBillingEventForRecovery(
    eventId: string,
    options?: {
      leaseOwner?: string;
      leaseDurationMs?: number;
      maxAttempts?: number;
      allowReplayFailed?: boolean;
      provider?: string;
    }
  ): Promise<{ claimed: boolean; event: BillingEventRecord | null; leaseOwner?: string }> {
    const leaseDurationMs = Math.max(50, options?.leaseDurationMs ?? 5 * 60 * 1000);
    const maxAttempts = Math.max(1, options?.maxAttempts ?? 5);
    const allowReplayFailed = Boolean(options?.allowReplayFailed);
    const providerFilter = options?.provider ? options.provider : null;
    const leaseOwner = options?.leaseOwner || `recovery_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const res = await this.query<any>(
      `UPDATE billing_events
       SET status = 'processing',
           lease_owner = $2,
           lease_expires_at = clock_timestamp() + ($3 * INTERVAL '1 millisecond'),
           attempt_count = COALESCE(attempt_count, 0) + 1,
           last_attempt_at = clock_timestamp(),
           next_retry_at = NULL,
           processed_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE event_id = $1
         AND ($4::text IS NULL OR provider = $4)
         AND status NOT IN ('processed', 'ignored')
         AND (
           $5::boolean = TRUE
           OR (
             status <> 'permanently_failed'
             AND COALESCE(attempt_count, 0) < $6
           )
         )
         AND (
           (status = 'failed' AND ($5::boolean = TRUE OR next_retry_at IS NULL OR next_retry_at <= clock_timestamp()))
           OR ($5::boolean = TRUE AND status = 'permanently_failed')
           OR (
             status = 'processing' AND (
               (lease_expires_at IS NOT NULL AND lease_expires_at < clock_timestamp())
               OR (lease_expires_at IS NULL AND processed_at < clock_timestamp() - INTERVAL '5 minutes')
             )
           )
         )
       RETURNING id, provider, event_id AS "eventId", event_type AS "eventType", idempotency_key AS "idempotencyKey",
                 payload_json AS "payload", status, lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
                 attempt_count AS "attemptCount", last_error AS "lastError", last_attempt_at AS "lastAttemptAt",
                 next_retry_at AS "nextRetryAt", processed_at AS "processedAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [eventId, leaseOwner, leaseDurationMs, providerFilter, allowReplayFailed, maxAttempts]
    );

    if (res.rows.length > 0) {
      return {
        claimed: true,
        leaseOwner,
        event: this.mapBillingEventRow(res.rows[0]),
      };
    }

    const existing = await this.getBillingEventById(eventId);
    return { claimed: false, event: existing };
  }

  async renewBillingEventLease(
    eventId: string,
    leaseOwner: string,
    extendMs: number = 5 * 60 * 1000
  ): Promise<boolean> {
    const safeExtendMs = Math.max(50, extendMs);
    const res = await this.query<{ id: string }>(
      `UPDATE billing_events
       SET lease_expires_at = clock_timestamp() + ($3 * INTERVAL '1 millisecond'),
           updated_at = clock_timestamp()
       WHERE event_id = $1
         AND lease_owner = $2
         AND status = 'processing'
         AND (
           (lease_expires_at IS NOT NULL AND lease_expires_at >= clock_timestamp())
           OR (lease_expires_at IS NULL AND processed_at >= clock_timestamp() - INTERVAL '5 minutes')
         )
       RETURNING id`,
      [eventId, leaseOwner, safeExtendMs]
    );
    return (res.rowCount || 0) > 0;
  }

  async updateBillingEventStatus(
    eventId: string,
    status: BillingEventStatus,
    payload?: any,
    leaseOwner?: string
  ): Promise<void> {
    const params: any[] = [eventId, status];
    const setClauses = ['status = $2', 'updated_at = clock_timestamp()'];
    if (status !== 'processing') {
      setClauses.push('lease_expires_at = NULL');
    }
    if (status === 'processed' || status === 'ignored') {
      setClauses.push('next_retry_at = NULL', 'last_error = NULL');
    }
    if (payload !== undefined) {
      params.push(JSON.stringify(payload));
      setClauses.push(`payload_json = $${params.length}::jsonb`);
    }

    let whereClause = 'WHERE event_id = $1';
    if (leaseOwner) {
      params.push(leaseOwner);
      whereClause += `
        AND lease_owner = $${params.length}
        AND status = 'processing'
        AND (
          (lease_expires_at IS NOT NULL AND lease_expires_at >= clock_timestamp())
          OR (lease_expires_at IS NULL AND processed_at >= clock_timestamp() - INTERVAL '5 minutes')
        )`;
    }

    const res = await this.query(
      `UPDATE billing_events
       SET ${setClauses.join(', ')}
       ${whereClause}`,
      params
    );

    if (leaseOwner && res.rowCount === 0) {
      throw new Error(`Billing lease ownership lost or expired for event ${eventId}: stale worker "${leaseOwner}" rejected.`);
    }
  }

  async markBillingEventFailure(params: {
    eventId: string;
    leaseOwner?: string;
    status: 'failed' | 'permanently_failed';
    errorMessage: string;
    nextRetryAt?: string | null;
  }): Promise<void> {
    const queryParams: any[] = [
      params.eventId,
      params.status,
      params.errorMessage,
      params.status === 'failed' ? (params.nextRetryAt ?? null) : null,
    ];
    let whereClause = 'WHERE event_id = $1';
    if (params.leaseOwner) {
      queryParams.push(params.leaseOwner);
      whereClause += `
        AND lease_owner = $${queryParams.length}
        AND status = 'processing'
        AND (
          (lease_expires_at IS NOT NULL AND lease_expires_at >= clock_timestamp())
          OR (lease_expires_at IS NULL AND processed_at >= clock_timestamp() - INTERVAL '5 minutes')
        )`;
    }

    const res = await this.query(
      `UPDATE billing_events
       SET status = $2,
           lease_expires_at = NULL,
           last_error = $3,
           last_attempt_at = COALESCE(last_attempt_at, clock_timestamp()),
           next_retry_at = $4,
           updated_at = clock_timestamp()
       ${whereClause}`,
      queryParams
    );

    if (params.leaseOwner && res.rowCount === 0) {
      throw new Error(`Billing lease ownership lost or expired for event ${params.eventId}: stale worker "${params.leaseOwner}" rejected.`);
    }
  }

  async applyBillingTransition(params: {
    eventId: string;
    subscription: SubscriptionRecord;
    storeProfileUpdate?: { tier: PlanTier; skuLimit?: number };
    markProcessed?: boolean;
    leaseOwner?: string;
  }): Promise<void> {
    return this.withTransaction(async (client) => {
      // 0. Lock and verify billing event lease ownership and live wall-clock clock_timestamp() BEFORE applying entitlement changes
      if (params.leaseOwner) {
        const lockRes = await client.query<{
          status: string;
          lease_owner: string | null;
          is_expired: boolean;
        }>(
          `SELECT status,
                  lease_owner,
                  (
                    (lease_expires_at IS NOT NULL AND lease_expires_at < clock_timestamp())
                    OR (lease_expires_at IS NULL AND processed_at < clock_timestamp() - INTERVAL '5 minutes')
                  ) AS is_expired
           FROM billing_events
           WHERE event_id = $1
           FOR UPDATE`,
          [params.eventId]
        );
        const evtRow = lockRes.rows[0];
        if (!evtRow || evtRow.status !== 'processing' || evtRow.lease_owner !== params.leaseOwner || evtRow.is_expired) {
          throw new Error(`Billing lease ownership lost or expired for event ${params.eventId}: stale worker "${params.leaseOwner}" rejected.`);
        }
      }

      // 1. Upsert subscription record
      await client.query(
        `INSERT INTO subscriptions (id, workspace_id, provider, customer_id, subscription_id, tier, status, current_period_start, current_period_end, cancel_at_period_end, last_event_created, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, clock_timestamp(), clock_timestamp())
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
           updated_at = clock_timestamp()`,
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
               updated_at = clock_timestamp()
           WHERE workspace_id = $1`,
          [
            params.subscription.workspaceId,
            params.storeProfileUpdate.tier,
            params.storeProfileUpdate.skuLimit !== undefined ? params.storeProfileUpdate.skuLimit : null,
          ]
        );
      }

      // 3. Re-verify non-expiration against clock_timestamp() right before COMMIT and mark billing event processed
      if (params.markProcessed !== false) {
        const updateQuery = params.leaseOwner
          ? `UPDATE billing_events
             SET status = 'processed',
                 lease_expires_at = NULL,
                 last_error = NULL,
                 next_retry_at = NULL,
                 processed_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE event_id = $1
               AND lease_owner = $2
               AND status = 'processing'
               AND (
                 (lease_expires_at IS NOT NULL AND lease_expires_at >= clock_timestamp())
                 OR (lease_expires_at IS NULL AND processed_at >= clock_timestamp() - INTERVAL '5 minutes')
               )`
          : `UPDATE billing_events
             SET status = 'processed',
                 lease_expires_at = NULL,
                 last_error = NULL,
                 next_retry_at = NULL,
                 processed_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE event_id = $1`;
        const updateRes = await client.query(
          updateQuery,
          params.leaseOwner ? [params.eventId, params.leaseOwner] : [params.eventId]
        );
        if (params.leaseOwner && updateRes.rowCount === 0) {
          throw new Error(`Billing lease ownership lost or expired during commit for event ${params.eventId}.`);
        }
      }
    });
  }

  // Catalog Audit Runs
  async createAuditRun(data: CreateAuditRunData): Promise<AuditRunRecord> {
    const query = `
      INSERT INTO audit_runs (id, workspace_id, status, products_evaluated, rules_evaluated, findings_count, summary_json, metadata_json, started_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, NOW(), NOW())
      RETURNING id, workspace_id AS "workspaceId", status, products_evaluated AS "productsEvaluated", rules_evaluated AS "rulesEvaluated", findings_count AS "findingsCount", summary_json AS "summaryJson", metadata_json AS "metadataJson", error_message AS "errorMessage", started_at AS "startedAt", completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const res = await this.query(query, [
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
    const res = await this.query(query, values);
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
    const res = await this.query(query, [id, workspaceId]);
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
    const res = await this.query(query, [workspaceId]);
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

    try {
      const nextCatalog = await this.withTransaction(async (client) => {
      const storeId = `store_${workspaceId}`;

      // Acquire exclusive row-level lock on store
      const storeRes = await client.query<{
        id: string;
        name: string;
        domain: string;
        website_url?: string;
        platform?: string | null;
        source_classification?: any;
        source_metadata_json?: any;
        evidence_coverage_avg?: number | null;
        last_audit_date?: string | null;
        shopify_connected?: boolean;
        shopify_shop_domain?: string | null;
        currency: string;
        sku_count: number;
        sku_limit: number | null;
        catalog_completeness_avg: number;
        truth_boundary_strictness: 'strict' | 'standard' | 'relaxed';
        tier: string;
        connectors_json: any;
      }>(
        `SELECT id, name, domain, website_url, platform, source_classification, source_metadata_json, evidence_coverage_avg, last_audit_date, shopify_connected, shopify_shop_domain, currency, sku_count, sku_limit, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json
         FROM stores
         WHERE workspace_id = $1
         FOR UPDATE`,
        [workspaceId]
      );

      if (!storeRes.rows[0]) {
        throw new Error(`Store for workspace ${workspaceId} not found`);
      }

      const rawStore = storeRes.rows[0];
      const rawDomain = rawStore.domain ?? '';
      const rawMeta = rawStore.source_metadata_json
        ? (typeof rawStore.source_metadata_json === 'string' ? JSON.parse(rawStore.source_metadata_json) : rawStore.source_metadata_json)
        : undefined;
      const authoritativeStore: StoreProfile = {
        name: rawStore.name,
        domain: rawDomain,
        websiteUrl: rawStore.website_url ?? rawDomain,
        ...(rawStore.platform ? { platform: rawStore.platform } : {}),
        sourceClassification: rawStore.source_classification || (rawStore.shopify_connected ? 'shopify_oauth' : 'unconfigured'),
        ...(rawMeta && Object.keys(rawMeta).length > 0 ? { sourceMetadata: rawMeta } : {}),
        shopifyConnected: Boolean(rawStore.shopify_connected),
        ...(rawStore.shopify_shop_domain ? { shopifyShopDomain: rawStore.shopify_shop_domain } : {}),
        currency: rawStore.currency,
        skuCount: rawStore.sku_count,
        skuLimit: (typeof rawStore.sku_limit === 'number' && !isNaN(rawStore.sku_limit)) ? rawStore.sku_limit : undefined,
        tier: rawStore.tier,
        connectors: typeof rawStore.connectors_json === 'string' ? JSON.parse(rawStore.connectors_json) : (rawStore.connectors_json || []),
        catalogCompletenessAvg: rawStore.catalog_completeness_avg,
        ...(typeof rawStore.evidence_coverage_avg === 'number' && !isNaN(rawStore.evidence_coverage_avg)
          ? { evidenceCoverageAvg: rawStore.evidence_coverage_avg }
          : {}),
        ...(rawStore.last_audit_date ? { lastAuditDate: rawStore.last_audit_date } : {}),
        truthBoundaryStrictness: rawStore.truth_boundary_strictness,
      };

      const catalog = await this.loadCatalogRows(client, workspaceId, authoritativeStore);

      // Load server-owned Shopify connection & product provenance inside transaction
      const [shopifyConnection, shopifyProvenance] = await Promise.all([
        this.getShopifyConnectionWithClient(client, workspaceId),
        this.getShopifyProductProvenanceWithClient(client, workspaceId),
      ]);
      const trustedGtinContext = buildTrustedGtinVerificationContext(
        workspaceId,
        catalog.products,
        shopifyConnection,
        shopifyProvenance
      );

      // Execute domain rules on real catalog data with TrustedGtinVerificationContext
      const auditResult = executeCatalogAudit(
        catalog.products,
        catalog.storeProfile || authoritativeStore,
        catalog.actions,
        trustedGtinContext
      );

      // Construct next catalog state
      const nextCatalog: StoragePayloadV1 = {
        ...catalog,
        products: auditResult.updatedProducts,
        findings: auditResult.findings,
        actions: auditResult.actionItems,
        evidence: auditResult.updatedProducts.flatMap(p => p.evidenceDocuments || []),
        storeProfile: auditResult.updatedStoreProfile,
      };

      // Save catalog rows atomically within this transaction and capture incremented version
      const nextVersion = await this.saveCatalogRows(client, workspaceId, nextCatalog, storeId, auditResult.updatedStoreProfile);
      nextCatalog.catalogVersion = nextVersion;

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
            JSON.stringify({
              evidencePurpose: e.evidencePurpose || 'general',
              verificationSource: e.verificationSource || 'client_submission',
              externalVerificationStatus: e.externalVerificationStatus || 'not_externally_verified',
              verifiedBy: e.verifiedBy || null,
              reviewerPrincipalType: e.reviewerPrincipalType || null,
              reviewerAuthMethod: e.reviewerAuthMethod || null,
              reviewedAt: e.reviewedAt || null,
              decision: e.decision || null,
              decisionReason: e.decisionReason || null,
              externalProviderName: e.externalProviderName || null,
              externalProviderRef: e.externalProviderRef || null,
              externalRequestAt: e.externalRequestAt || null,
              externalResponseAt: e.externalResponseAt || null,
              externalVerificationResult: e.externalVerificationResult || null,
              integrityHash: e.integrityHash || null,
            }),
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

        return nextCatalog;
      });

      auditRun = (await this.getAuditRunById(runId, workspaceId))!;

      return {
        auditRun,
        catalog: nextCatalog,
      };
    } catch (err: any) {
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
    }
  }

  async getAuditRunsHistory(
    workspaceId: string,
    options?: { limit?: number; cursor?: string }
  ): Promise<{ items: Array<AuditRunRecord & { snapshotAvailable: boolean }>; nextCursor: string | null; totalCount: number }> {
    const limit = Math.min(Math.max(options?.limit || 20, 1), 100);

    // Get total count of runs for workspace
    const countRes = await this.query<{ count: string }>(
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
      const cursorRes = await this.query<{ created_at: Date }>(
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

    const res = await this.query(query, params);
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
    const manifestRes = await this.query<{ status: string }>(
      'SELECT status FROM audit_run_manifests WHERE audit_run_id = $1 AND workspace_id = $2',
      [auditRunId, workspaceId]
    );
    const hasManifest = manifestRes.rows.length > 0 || (auditRun.metadata && auditRun.metadata.snapshotAvailable === true);

    const findingsRes = await this.query<any>(
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

    const productsRes = await this.query<any>(
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

    const evidenceRes = await this.query<any>(
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
    const res = await this.query<any>(
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
    const res = await this.query<any>(
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
    await this.query(
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
    await this.query(
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
    await this.query(
      `INSERT INTO shopify_oauth_states (id, workspace_id, shop_domain, expires_at, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET
         shop_domain = EXCLUDED.shop_domain,
         expires_at = EXCLUDED.expires_at`,
      [state.id, state.workspaceId, state.shopDomain, state.expiresAt]
    );
  }

  async getAndConsumeShopifyOAuthState(stateId: string): Promise<{ id: string; workspaceId: string; shopDomain: string; expiresAt: string } | null> {
    const res = await this.query<any>(
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
    const res = await this.query<any>(
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
    return this.updateShopifySyncRunWithClient(
      { query: (text: string, params?: any[]) => this.query(text, params) },
      id,
      workspaceId,
      updates
    );
  }

  private async updateShopifySyncRunWithClient(
    queryable: { query: (text: string, params?: any[]) => Promise<any> },
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

    const res = await queryable.query(
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
    const res = await this.query<any>(
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
    const res = await this.query<any>(
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
    const res = await this.query<any>(
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

  async claimShopifyWebhookEvent(
    event: import('../shopify/types').ShopifyWebhookEventRecord,
    leaseOptions?: { leaseOwner?: string; leaseDurationMs?: number }
  ): Promise<import('../shopify/types').ShopifyWebhookClaimResult> {
    const leaseDurationMs = Math.max(50, leaseOptions?.leaseDurationMs ?? 5 * 60 * 1000);
    const leaseOwner = leaseOptions?.leaseOwner || `wh_worker_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const res = await this.query<any>(
      `INSERT INTO shopify_webhook_events (
        id, workspace_id, shop_domain, event_id, topic, delivery_id,
        payload_json, status, retry_count, lease_owner, lease_expires_at, attempt_count, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb, 'processing', 0, $8, clock_timestamp() + ($9 * INTERVAL '1 millisecond'), 1, clock_timestamp(), clock_timestamp()
      )
      ON CONFLICT (shop_domain, topic, event_id) DO UPDATE SET
        status = 'processing',
        payload_json = CASE WHEN EXCLUDED.payload_json <> '{}'::jsonb THEN EXCLUDED.payload_json ELSE shopify_webhook_events.payload_json END,
        delivery_id = COALESCE(EXCLUDED.delivery_id, shopify_webhook_events.delivery_id),
        lease_owner = EXCLUDED.lease_owner,
        lease_expires_at = clock_timestamp() + ($9 * INTERVAL '1 millisecond'),
        attempt_count = COALESCE(shopify_webhook_events.attempt_count, 0) + 1,
        retry_count = COALESCE(shopify_webhook_events.retry_count, 0) + 1,
        updated_at = clock_timestamp()
      WHERE shopify_webhook_events.status = 'failed'
         OR (
           shopify_webhook_events.status = 'processing' AND (
             (shopify_webhook_events.lease_expires_at IS NOT NULL AND shopify_webhook_events.lease_expires_at < clock_timestamp())
             OR (shopify_webhook_events.lease_expires_at IS NULL AND shopify_webhook_events.updated_at < clock_timestamp() - INTERVAL '5 minutes')
           )
         )
      RETURNING
        id, workspace_id AS "workspaceId", shop_domain AS "shopDomain",
        event_id AS "eventId", topic, delivery_id AS "deliveryId",
        payload_json AS "payload", status, retry_count AS "retryCount",
        lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
        attempt_count AS "attemptCount", last_error AS "lastError",
        processed_at AS "processedAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        event.id,
        event.workspaceId,
        event.shopDomain,
        event.eventId,
        event.topic,
        event.deliveryId || null,
        JSON.stringify(event.payload || {}),
        leaseOwner,
        leaseDurationMs,
      ]
    );

    if (res.rows.length > 0) {
      const row = res.rows[0];
      const attemptCount = Number(row.attemptCount ?? 1);
      return {
        claimed: true,
        outcome: attemptCount > 1 ? 'RETRYABLE_FAILED' : 'CLAIMED',
        leaseOwner,
        event: {
          ...row,
          leaseExpiresAt: row.leaseExpiresAt ? new Date(row.leaseExpiresAt).toISOString() : null,
          processedAt: row.processedAt ? new Date(row.processedAt).toISOString() : null,
          createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : event.createdAt,
          updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : event.updatedAt,
        },
      };
    }

    const existingRes = await this.query<any>(
      `SELECT 
        id, workspace_id AS "workspaceId", shop_domain AS "shopDomain",
        event_id AS "eventId", topic, delivery_id AS "deliveryId",
        payload_json AS "payload", status, retry_count AS "retryCount",
        lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
        attempt_count AS "attemptCount", last_error AS "lastError",
        processed_at AS "processedAt", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM shopify_webhook_events
       WHERE shop_domain = $1 AND topic = $2 AND event_id = $3`,
      [event.shopDomain, event.topic, event.eventId]
    );
    const existing = existingRes.rows[0] || null;
    if (existing && existing.status === 'processing') {
      return {
        claimed: false,
        outcome: 'CURRENTLY_PROCESSING',
        event: existing,
      };
    }
    return {
      claimed: false,
      outcome: 'ALREADY_PROCESSED',
      event: existing,
    };
  }

  async updateShopifyWebhookEventStatus(
    eventId: string,
    shopDomain: string,
    topic: string,
    status: 'processing' | 'processed' | 'failed' | 'ignored',
    error?: string,
    leaseOwner?: string
  ): Promise<void> {
    return this.updateShopifyWebhookEventStatusWithClient(
      { query: (text: string, params?: any[]) => this.query(text, params) },
      eventId,
      shopDomain,
      topic,
      status,
      error,
      leaseOwner
    );
  }

  private async updateShopifyWebhookEventStatusWithClient(
    queryable: { query: (text: string, params?: any[]) => Promise<any> },
    eventId: string,
    shopDomain: string,
    topic: string,
    status: 'processing' | 'processed' | 'failed' | 'ignored',
    error?: string,
    leaseOwner?: string
  ): Promise<void> {
    const params: any[] = [shopDomain, topic, eventId, status, error || null];
    let whereClause = 'WHERE shop_domain = $1 AND topic = $2 AND event_id = $3';
    if (leaseOwner) {
      params.push(leaseOwner);
      whereClause += `
        AND lease_owner = $${params.length}
        AND status = 'processing'
        AND (
          (lease_expires_at IS NOT NULL AND lease_expires_at >= clock_timestamp())
          OR (lease_expires_at IS NULL AND updated_at >= clock_timestamp() - INTERVAL '5 minutes')
        )`;
    }

    const res = await queryable.query(
      `UPDATE shopify_webhook_events
       SET status = CAST($4 AS VARCHAR(32)),
           last_error = $5,
           lease_expires_at = CASE WHEN CAST($4 AS VARCHAR(32)) <> 'processing' THEN NULL ELSE lease_expires_at END,
           processed_at = CASE WHEN CAST($4 AS VARCHAR(32)) = 'processed' THEN clock_timestamp() ELSE processed_at END,
           updated_at = clock_timestamp()
       ${whereClause}`,
      params
    );

    if (leaseOwner && res.rowCount === 0) {
      throw new Error(
        `Shopify webhook lease ownership lost or expired for event ${eventId}: stale worker "${leaseOwner}" rejected.`
      );
    }
  }

  async withShopifyRefreshLock<T>(
    workspaceId: string,
    fn: (
      connection: import('../shopify/types').ShopifyConnectionRecord,
      saveConnection: (conn: import('../shopify/types').ShopifyConnectionRecord) => Promise<import('../shopify/types').ShopifyConnectionRecord>
    ) => Promise<T>
  ): Promise<T> {
    return this.withTransaction(async (client) => {
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

      return await fn(lockedConn, saveConnection);
    });
  }

  async getWorkspaceBusinessProfile(workspaceId: string): Promise<import('../../domain/businessProfile/types').WorkspaceBusinessProfile | null> {
    const res = await this.query<any>(
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
    const res = await this.query<any>(
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
    await this.query(
      `INSERT INTO ai_visibility_imports (
        id, workspace_id, filename, content_hash, row_count, rejected_row_count, status, errors_json,
        reporting_period_start, reporting_period_end, source_platform, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, NOW())`,
      [
        record.id,
        record.workspaceId,
        record.filename,
        record.contentHash || null,
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

  async getVisibilityImportByHash(
    workspaceId: string,
    contentHash: string
  ): Promise<import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord | null> {
    if (!contentHash) return null;
    const res = await this.query<any>(
      `SELECT
        id, workspace_id AS "workspaceId", filename, content_hash AS "contentHash",
        row_count AS "rowCount", rejected_row_count AS "rejectedRowCount", status,
        errors_json AS "errors", reporting_period_start::text AS "reportingPeriodStart",
        reporting_period_end::text AS "reportingPeriodEnd",
        source_platform AS "sourcePlatform", created_at AS "createdAt"
       FROM ai_visibility_imports
       WHERE workspace_id = $1
         AND content_hash = $2
         AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 1`,
      [workspaceId, contentHash]
    );
    return res.rows[0] || null;
  }

  private resolveVisibilityTopicKey(metric: VisibilityMetricRecord): {
    topicValue: string | null;
    topicPresence: TopicPresenceState;
  } {
    if (metric.discoveryTopic === null || metric.discoveryTopic === undefined) {
      return { topicValue: null, topicPresence: metric.topicPresence || 'unspecified' };
    }
    if (metric.discoveryTopic === '') {
      return { topicValue: '', topicPresence: metric.topicPresence || 'explicit_blank' };
    }
    return { topicValue: metric.discoveryTopic, topicPresence: metric.topicPresence || 'specified' };
  }

  private buildCanonicalVisibilityLockKey(metric: VisibilityMetricRecord): string {
    const { topicValue } = this.resolveVisibilityTopicKey(metric);
    const topicPart = topicValue === null ? '__NULL__' : `STR:${topicValue}`;
    return `${metric.workspaceId}::${metric.observationDate}::${metric.platform}::${topicPart}`;
  }

  async saveVisibilityMetrics(metrics: VisibilityMetricRecord[]): Promise<void> {
    for (const m of metrics) {
      const { topicValue, topicPresence } = this.resolveVisibilityTopicKey(m);
      if (topicValue === null) {
        await this.query(
          `INSERT INTO ai_visibility_metrics (
            id, workspace_id, import_id, observation_date, platform, brand_mentions, product_mentions, website_clicks, discovery_topic, topic_presence, evidence_source, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, NOW())
          ON CONFLICT (workspace_id, observation_date, platform) WHERE discovery_topic IS NULL DO UPDATE SET
            import_id = EXCLUDED.import_id,
            brand_mentions = EXCLUDED.brand_mentions,
            product_mentions = EXCLUDED.product_mentions,
            website_clicks = EXCLUDED.website_clicks,
            topic_presence = EXCLUDED.topic_presence,
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
            topicPresence,
            m.evidenceSource || null,
          ]
        );
      } else {
        await this.query(
          `INSERT INTO ai_visibility_metrics (
            id, workspace_id, import_id, observation_date, platform, brand_mentions, product_mentions, website_clicks, discovery_topic, topic_presence, evidence_source, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
          ON CONFLICT (workspace_id, observation_date, platform, discovery_topic) DO UPDATE SET
            import_id = EXCLUDED.import_id,
            brand_mentions = EXCLUDED.brand_mentions,
            product_mentions = EXCLUDED.product_mentions,
            website_clicks = EXCLUDED.website_clicks,
            topic_presence = EXCLUDED.topic_presence,
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
            topicValue,
            topicPresence,
            m.evidenceSource || null,
          ]
        );
      }
    }
  }

  async saveVisibilityImportAtomic(
    record: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord,
    metrics: VisibilityMetricRecord[],
    options: { conflictPolicy?: VisibilityConflictPolicy } = {}
  ): Promise<{
    importRecord: import('../../domain/monitoring/aiVisibilityTypes').VisibilityImportRecord;
    metricsSaved: number;
    duplicateImport?: boolean;
    replacedCount?: number;
  }> {
    const policy: VisibilityConflictPolicy = options.conflictPolicy || 'reject_on_conflict';

    try {
      return await this.withTransaction(async (client) => {
        try {
          await client.query(
            `INSERT INTO ai_visibility_imports (
              id, workspace_id, filename, content_hash, row_count, rejected_row_count, status, errors_json,
              reporting_period_start, reporting_period_end, source_platform, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, NOW())`,
            [
              record.id,
              record.workspaceId,
              record.filename,
              record.contentHash || null,
              record.rowCount,
              record.rejectedRowCount ?? 0,
              record.status || 'completed',
              JSON.stringify(record.errors || []),
              record.reportingPeriodStart || null,
              record.reportingPeriodEnd || null,
              record.sourcePlatform || 'merchant_upload',
            ]
          );
        } catch (insertErr: any) {
          const isHashDup =
            insertErr?.code === '23505' &&
            (!insertErr?.constraint || String(insertErr.constraint).includes('ai_visibility_imports_ws_hash'));
          if (isHashDup && record.contentHash) {
            throw new VisibilityDuplicateHashSentinel();
          }
          throw insertErr;
        }

        // Acquire sorted transaction-scoped advisory locks per canonical observation key
        // BEFORE querying or inserting metrics so concurrent imports on nonexistent keys serialize cleanly
        // without deadlocking and preserving NULL vs '' distinction.
        const sortedLockKeys = Array.from(
          new Set(metrics.map((m) => this.buildCanonicalVisibilityLockKey(m)))
        ).sort();
        for (const lockKey of sortedLockKeys) {
          await client.query(`SELECT pg_advisory_xact_lock(hashtext('aixshop_vis'), hashtext($1))`, [lockKey]);
        }

        const existingByIdx: Array<{ id: string; import_id: string | null } | undefined> = [];
        const conflicts: VisibilityObservationConflict[] = [];
        let replacedCount = 0;

        for (let i = 0; i < metrics.length; i++) {
          const m = metrics[i];
          const { topicValue, topicPresence } = this.resolveVisibilityTopicKey(m);

          const existingMetricRes = await client.query<{
            id: string;
            import_id: string | null;
            brand_mentions: number;
            product_mentions: number;
            website_clicks: number;
            topic_presence?: TopicPresenceState;
          }>(
            `SELECT id, import_id, brand_mentions, product_mentions, website_clicks, topic_presence
             FROM ai_visibility_metrics
             WHERE workspace_id = $1
               AND observation_date = $2
               AND platform = $3
               AND discovery_topic IS NOT DISTINCT FROM $4
             FOR UPDATE`,
            [m.workspaceId, m.observationDate, m.platform, topicValue]
          );

          const existingMetric = existingMetricRes.rows[0];
          existingByIdx[i] = existingMetric;

          if (existingMetric && existingMetric.import_id !== record.id) {
            if (policy === 'reject_on_conflict') {
              conflicts.push({
                observationDate: m.observationDate,
                platform: m.platform,
                discoveryTopic: topicValue,
                topicPresence,
                existingImportId: existingMetric.import_id || null,
                existingValues: {
                  brandMentions: Number(existingMetric.brand_mentions || 0),
                  productMentions: Number(existingMetric.product_mentions || 0),
                  websiteClicks: Number(existingMetric.website_clicks || 0),
                },
                incomingValues: {
                  brandMentions: m.brandMentions,
                  productMentions: m.productMentions,
                  websiteClicks: m.websiteClicks,
                },
              });
            } else {
              replacedCount++;
            }
          }
        }

        if (conflicts.length > 0) {
          throw new VisibilityObservationConflictError(conflicts);
        }

        for (let i = 0; i < metrics.length; i++) {
          const m = metrics[i];
          const { topicValue, topicPresence } = this.resolveVisibilityTopicKey(m);
          const existingMetric = existingByIdx[i];

          // Query latest immutable observation version under FOR UPDATE to maintain append-only history lineage
          const histVerRes = await client.query<{ id: string; version_number: number }>(
            `SELECT id, version_number
             FROM ai_visibility_observation_history
             WHERE workspace_id = $1
               AND observation_date = $2
               AND platform = $3
               AND discovery_topic IS NOT DISTINCT FROM $4
             ORDER BY version_number DESC
             LIMIT 1
             FOR UPDATE`,
            [m.workspaceId, m.observationDate, m.platform, topicValue]
          );
          const prevHist = histVerRes.rows[0];
          const nextVersion = Number(prevHist?.version_number || 0) + 1;

          await client.query(
            `INSERT INTO ai_visibility_observation_history (
              id, workspace_id, import_id, observation_date, platform, discovery_topic, topic_presence,
              brand_mentions, product_mentions, website_clicks, evidence_source, event_type, version_number, supersedes_history_id, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())`,
            [
              `vhist_${m.id}`,
              m.workspaceId,
              record.id,
              m.observationDate,
              m.platform,
              topicValue,
              topicPresence,
              m.brandMentions,
              m.productMentions,
              m.websiteClicks,
              m.evidenceSource || null,
              existingMetric ? 'replaced' : 'recorded',
              nextVersion,
              prevHist?.id || null,
            ]
          );

          if (topicValue === null) {
            await client.query(
              `INSERT INTO ai_visibility_metrics (
                id, workspace_id, import_id, observation_date, platform, brand_mentions, product_mentions, website_clicks, discovery_topic, topic_presence, evidence_source, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, NOW())
              ON CONFLICT (workspace_id, observation_date, platform) WHERE discovery_topic IS NULL DO UPDATE SET
                import_id = EXCLUDED.import_id,
                brand_mentions = EXCLUDED.brand_mentions,
                product_mentions = EXCLUDED.product_mentions,
                website_clicks = EXCLUDED.website_clicks,
                topic_presence = EXCLUDED.topic_presence,
                evidence_source = EXCLUDED.evidence_source`,
              [
                m.id,
                m.workspaceId,
                m.importId || record.id,
                m.observationDate,
                m.platform,
                m.brandMentions,
                m.productMentions,
                m.websiteClicks,
                topicPresence,
                m.evidenceSource || null,
              ]
            );
          } else {
            await client.query(
              `INSERT INTO ai_visibility_metrics (
                id, workspace_id, import_id, observation_date, platform, brand_mentions, product_mentions, website_clicks, discovery_topic, topic_presence, evidence_source, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
              ON CONFLICT (workspace_id, observation_date, platform, discovery_topic) DO UPDATE SET
                import_id = EXCLUDED.import_id,
                brand_mentions = EXCLUDED.brand_mentions,
                product_mentions = EXCLUDED.product_mentions,
                website_clicks = EXCLUDED.website_clicks,
                topic_presence = EXCLUDED.topic_presence,
                evidence_source = EXCLUDED.evidence_source`,
              [
                m.id,
                m.workspaceId,
                m.importId || record.id,
                m.observationDate,
                m.platform,
                m.brandMentions,
                m.productMentions,
                m.websiteClicks,
                topicValue,
                topicPresence,
                m.evidenceSource || null,
              ]
            );
          }
        }

        return {
          importRecord: record,
          metricsSaved: metrics.length,
          duplicateImport: false,
          replacedCount,
        };
      });
    } catch (err) {
      if (err instanceof VisibilityDuplicateHashSentinel && record.contentHash) {
        const existingImport = await this.getVisibilityImportByHash(record.workspaceId, record.contentHash);
        if (existingImport) {
          return {
            importRecord: existingImport,
            metricsSaved: 0,
            duplicateImport: true,
          };
        }
      }
      throw err;
    }
  }

  async getVisibilityObservationHistory(
    workspaceId: string,
    limit = 100
  ): Promise<VisibilityObservationHistoryRecord[]> {
    const res = await this.query<any>(
      `SELECT
        id, workspace_id AS "workspaceId", import_id AS "importId",
        observation_date::text AS "observationDate", platform,
        discovery_topic AS "discoveryTopic", topic_presence AS "topicPresence",
        brand_mentions AS "brandMentions", product_mentions AS "productMentions",
        website_clicks AS "websiteClicks", evidence_source AS "evidenceSource",
        event_type AS "eventType", version_number AS "versionNumber",
        supersedes_history_id AS "supersedesHistoryId", created_at AS "createdAt"
       FROM ai_visibility_observation_history
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [workspaceId, limit]
    );
    return res.rows;
  }

  async getVisibilitySummary(workspaceId: string): Promise<import('../../domain/monitoring/aiVisibilityTypes').VisibilitySummary> {
    const metricsRes = await this.query<any>(
      `SELECT 
        id, workspace_id AS "workspaceId", import_id AS "importId",
        observation_date::text AS "observationDate", platform,
        brand_mentions AS "brandMentions", product_mentions AS "productMentions",
        website_clicks AS "websiteClicks", discovery_topic AS "discoveryTopic",
        topic_presence AS "topicPresence",
        evidence_source AS "evidenceSource", created_at AS "createdAt"
       FROM ai_visibility_metrics
       WHERE workspace_id = $1
       ORDER BY observation_date DESC
       LIMIT 100`,
      [workspaceId]
    );

    const importsRes = await this.query<any>(
      `SELECT 
        id, workspace_id AS "workspaceId", filename, content_hash AS "contentHash", row_count AS "rowCount",
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

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [passwordHash, userId]
    );
  }

  async createPasswordResetToken(data: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
    requestedIp?: string;
  }): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [data.userId]);
      await client.query(
        `UPDATE password_reset_tokens
         SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [data.userId]
      );
      await client.query(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, requested_ip, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [data.id, data.userId, data.tokenHash, data.expiresAt, data.requestedIp || null]
      );
    });
  }

  async invalidatePasswordResetToken(tokenId: string): Promise<void> {
    await this.query(
      `UPDATE password_reset_tokens
       SET used_at = COALESCE(used_at, NOW())
       WHERE id = $1`,
      [tokenId]
    );
  }

  async consumePasswordResetTokenAndUpdatePassword(
    tokenHash: string,
    newPasswordHash: string
  ): Promise<{ userId: string } | null> {
    return this.withTransaction(async (client) => {
      const claimRes = await client.query<{ id: string; userId: string }>(
        `UPDATE password_reset_tokens
         SET used_at = NOW()
         WHERE token_hash = $1
           AND used_at IS NULL
           AND expires_at > NOW()
         RETURNING id, user_id AS "userId"`,
        [tokenHash]
      );
      const claimed = claimRes.rows[0];
      if (!claimed) {
        return null;
      }

      await client.query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
        [newPasswordHash, claimed.userId]
      );
      await client.query(
        `UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
        [claimed.userId]
      );
      await client.query(
        `DELETE FROM sessions WHERE user_id = $1`,
        [claimed.userId]
      );

      return { userId: claimed.userId };
    });
  }

  async acquireWorkspaceOperationLease(
    workspaceId: string,
    operationKey: string,
    leaseOwner: string,
    ttlMs: number
  ): Promise<{ acquired: boolean; leaseOwner?: string; expiresAt?: string }> {
    const safeTtlMs = Math.max(1000, ttlMs);
    const res = await this.query<{ leaseOwner: string; expiresAt: string }>(
      `INSERT INTO workspace_operation_leases (
         workspace_id, operation_key, lease_owner, lease_expires_at, acquired_at, updated_at
       ) VALUES (
         $1, $2, $3, clock_timestamp() + ($4 * INTERVAL '1 millisecond'), clock_timestamp(), clock_timestamp()
       )
       ON CONFLICT (workspace_id, operation_key) DO UPDATE SET
         lease_owner = EXCLUDED.lease_owner,
         lease_expires_at = EXCLUDED.lease_expires_at,
         acquired_at = clock_timestamp(),
         updated_at = clock_timestamp()
       WHERE workspace_operation_leases.lease_expires_at <= clock_timestamp()
          OR workspace_operation_leases.lease_owner = EXCLUDED.lease_owner
       RETURNING lease_owner AS "leaseOwner", lease_expires_at::text AS "expiresAt"`,
      [workspaceId, operationKey, leaseOwner, safeTtlMs]
    );

    if (res.rows[0]) {
      return {
        acquired: true,
        leaseOwner: res.rows[0].leaseOwner,
        expiresAt: res.rows[0].expiresAt,
      };
    }

    const holderRes = await this.query<{ leaseOwner: string; expiresAt: string }>(
      `SELECT lease_owner AS "leaseOwner", lease_expires_at::text AS "expiresAt"
       FROM workspace_operation_leases
       WHERE workspace_id = $1 AND operation_key = $2
       LIMIT 1`,
      [workspaceId, operationKey]
    );
    return {
      acquired: false,
      leaseOwner: holderRes.rows[0]?.leaseOwner,
      expiresAt: holderRes.rows[0]?.expiresAt,
    };
  }

  async releaseWorkspaceOperationLease(
    workspaceId: string,
    operationKey: string,
    leaseOwner: string
  ): Promise<void> {
    await this.query(
      `DELETE FROM workspace_operation_leases
       WHERE workspace_id = $1 AND operation_key = $2 AND lease_owner = $3`,
      [workspaceId, operationKey, leaseOwner]
    );
  }

  // ==========================================
  // GTIN Evidence Verification & Shopify Provenance (Migration 015)
  // ==========================================

  private async getShopifyConnectionWithClient(
    queryable: { query: (text: string, params?: any[]) => Promise<any> },
    workspaceId: string
  ): Promise<import('../shopify/types').ShopifyConnectionRecord | null> {
    const res = await queryable.query(
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

  private async getShopifyProductProvenanceWithClient(
    queryable: { query: (text: string, params?: any[]) => Promise<any> },
    workspaceId: string
  ): Promise<ShopifyProductProvenanceRecord[]> {
    const res = await queryable.query(
      `SELECT
        workspace_id AS "workspaceId",
        product_id AS "productId",
        shop_domain AS "shopDomain",
        shopify_product_id AS "shopifyProductId",
        shopify_gid AS "shopifyGid",
        is_gift_card AS "isGiftCard",
        source_type AS "sourceType",
        shopify_updated_at AS "shopifyUpdatedAt",
        verified_at AS "verifiedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
       FROM shopify_product_provenance
       WHERE workspace_id = $1`,
      [workspaceId]
    );
    return res.rows.map((r: any) => ({
      workspaceId: r.workspaceId,
      productId: r.productId,
      shopDomain: r.shopDomain,
      shopifyProductId: r.shopifyProductId,
      shopifyGid: r.shopifyGid,
      isGiftCard: Boolean(r.isGiftCard),
      sourceType: r.sourceType,
      shopifyUpdatedAt: r.shopifyUpdatedAt || undefined,
      verifiedAt: r.verifiedAt ? new Date(r.verifiedAt).toISOString() : new Date().toISOString(),
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : undefined,
    }));
  }

  async submitEvidenceDocument(params: {
    workspaceId: string;
    productId: string;
    title: string;
    type: EvidenceDocument['type'];
    issuer: string;
    dateVerified?: string;
    url?: string;
    evidencePurpose?: EvidencePurpose;
    submittedByUserId: string;
    id?: string;
  }): Promise<{ evidence: EvidenceDocument; catalogVersion?: number }> {
    return this.withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('aixshop_cat'), hashtext($1))`, [params.workspaceId]);

      const storeRes = await client.query<{ id: string }>(
        `SELECT id FROM stores WHERE workspace_id = $1 FOR UPDATE`,
        [params.workspaceId]
      );
      if (storeRes.rows.length === 0) {
        const err: any = new Error(`Workspace ${params.workspaceId} catalog not found`);
        err.statusCode = 404;
        err.code = 'CATALOG_NOT_FOUND';
        throw err;
      }

      const prodRes = await client.query<{ id: string }>(
        `SELECT id FROM products WHERE workspace_id = $1 AND id = $2`,
        [params.workspaceId, params.productId]
      );
      if (prodRes.rows.length === 0) {
        const err: any = new Error(`Product "${params.productId}" not found in workspace ${params.workspaceId}`);
        err.statusCode = 404;
        err.code = 'PRODUCT_NOT_FOUND';
        throw err;
      }

      const nowIso = new Date().toISOString();
      const id =
        params.id?.trim() ||
        `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const purpose: EvidencePurpose =
        params.evidencePurpose === 'gtin_exemption' ||
        params.evidencePurpose === 'product_claim' ||
        params.evidencePurpose === 'general'
          ? params.evidencePurpose
          : 'general';

      const newDoc: EvidenceDocument = {
        id,
        title: String(params.title || '').trim(),
        type: params.type,
        issuer: String(params.issuer || '').trim(),
        dateVerified: String(params.dateVerified || '').trim(),
        url: params.url ? String(params.url).trim() : undefined,
        status: 'pending',
        evidencePurpose: purpose,
        verificationSource: 'client_submission',
        externalVerificationStatus: 'not_externally_verified',
        submittedByUserId: params.submittedByUserId,
        decision: 'pending',
        createdAt: nowIso,
      };
      newDoc.integrityHash = computeEvidenceIntegrityHash(params.workspaceId, params.productId, newDoc);

      await client.query(
        `DELETE FROM evidence_documents WHERE workspace_id = $1 AND id = $2`,
        [params.workspaceId, id]
      );
      await client.query(
        `INSERT INTO evidence_documents (
           id, workspace_id, product_id, title, type, issuer, date_verified, url, status,
           evidence_purpose, verification_source, external_verification_status,
           submitted_by_user_id, reviewed_by, reviewed_at,
           decision, decision_reason, integrity_hash, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, 'client_submission', 'not_externally_verified', $10, NULL, NULL, 'pending', NULL, $11, $12::timestamptz)`,
        [
          id,
          params.workspaceId,
          params.productId,
          newDoc.title,
          newDoc.type,
          newDoc.issuer,
          newDoc.dateVerified,
          newDoc.url || null,
          purpose,
          params.submittedByUserId,
          newDoc.integrityHash,
          nowIso,
        ]
      );

      const verRes = await client.query<{ catalog_version: number }>(
        `UPDATE stores SET catalog_version = COALESCE(catalog_version, 1) + 1, updated_at = NOW() WHERE workspace_id = $1 RETURNING catalog_version`,
        [params.workspaceId]
      );

      await client.query(
        `INSERT INTO evidence_review_audit_log (
           id, workspace_id, evidence_id, product_id, action, decision, reviewer_id, reviewer_role, principal_type, auth_method, reason, integrity_hash, metadata_json, created_at
         ) VALUES ($1, $2, $3, $4, 'submitted', 'pending', $5, 'merchant_submitter', 'merchant_submitter', 'workspace_session', NULL, $6, $7::jsonb, $8::timestamptz)`,
        [
          `evlog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          params.workspaceId,
          id,
          params.productId,
          params.submittedByUserId,
          newDoc.integrityHash,
          JSON.stringify({
            evidencePurpose: purpose,
            verificationSource: 'client_submission',
            externalVerificationStatus: 'not_externally_verified',
          }),
          nowIso,
        ]
      );

      return {
        evidence: newDoc,
        catalogVersion: Number(verRes.rows[0]?.catalog_version ?? 1),
      };
    });
  }

  async getEvidenceDocumentById(
    workspaceId: string,
    evidenceId: string
  ): Promise<{ evidence: EvidenceDocument; productId: string; product?: Product } | null> {
    const eviRes = await this.query<any>(
      `SELECT
        id,
        product_id AS "productId",
        title,
        type,
        issuer,
        date_verified AS "dateVerified",
        url,
        status,
        evidence_purpose AS "evidencePurpose",
        verification_source AS "verificationSource",
        external_verification_status AS "externalVerificationStatus",
        submitted_by_user_id AS "submittedByUserId",
        reviewed_by AS "verifiedBy",
        reviewer_principal_type AS "reviewerPrincipalType",
        reviewer_auth_method AS "reviewerAuthMethod",
        reviewed_at AS "reviewedAt",
        decision,
        decision_reason AS "decisionReason",
        external_provider_name AS "externalProviderName",
        external_provider_ref AS "externalProviderRef",
        external_request_at AS "externalRequestAt",
        external_response_at AS "externalResponseAt",
        external_verification_result AS "externalVerificationResult",
        external_verification_evidence_json AS "externalVerificationEvidence",
        integrity_hash AS "integrityHash",
        created_at AS "createdAt"
       FROM evidence_documents
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, evidenceId]
    );
    if (eviRes.rows.length === 0) return null;
    const r = eviRes.rows[0];
    const evidence: EvidenceDocument = {
      id: r.id,
      title: r.title,
      type: r.type,
      issuer: r.issuer,
      dateVerified: r.dateVerified,
      url: r.url || undefined,
      status: r.status,
      evidencePurpose: r.evidencePurpose || 'general',
      verificationSource: r.verificationSource || 'client_submission',
      externalVerificationStatus: r.externalVerificationStatus || 'not_externally_verified',
      submittedByUserId: r.submittedByUserId || undefined,
      verifiedBy: r.verifiedBy || undefined,
      reviewerPrincipalType: r.reviewerPrincipalType || undefined,
      reviewerAuthMethod: r.reviewerAuthMethod || undefined,
      reviewedAt: r.reviewedAt ? new Date(r.reviewedAt).toISOString() : undefined,
      decision: r.decision || undefined,
      decisionReason: r.decisionReason || undefined,
      externalProviderName: r.externalProviderName || undefined,
      externalProviderRef: r.externalProviderRef || undefined,
      externalRequestAt: r.externalRequestAt ? new Date(r.externalRequestAt).toISOString() : undefined,
      externalResponseAt: r.externalResponseAt ? new Date(r.externalResponseAt).toISOString() : undefined,
      externalVerificationResult: r.externalVerificationResult || undefined,
      externalVerificationEvidence: r.externalVerificationEvidence
        ? typeof r.externalVerificationEvidence === 'string'
          ? JSON.parse(r.externalVerificationEvidence)
          : r.externalVerificationEvidence
        : undefined,
      integrityHash: r.integrityHash || undefined,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
    };

    let product: Product | undefined;
    const prodRes = await this.query<any>(
      `SELECT id, title, brand, category, description, image, status, completeness_score AS "completenessScore",
              evidence_coverage_score AS "evidenceCoverageScore", external_discovery_status AS "externalDiscoveryStatus",
              attributes_json AS "attributesJson", findings_count AS "findingsCount", last_audited AS "lastAudited"
       FROM products
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, r.productId]
    );
    if (prodRes.rows.length > 0) {
      const pr = prodRes.rows[0];
      const varRes = await this.query<any>(
        `SELECT id, sku, title, barcode, price, inventory_count AS "inventoryCount", attributes_json AS "attributesJson"
         FROM variants WHERE workspace_id = $1 AND product_id = $2`,
        [workspaceId, pr.id]
      );
      product = {
        id: pr.id,
        title: pr.title,
        brand: pr.brand,
        category: pr.category,
        description: pr.description,
        image: pr.image,
        status: pr.status,
        completenessScore: pr.completenessScore,
        evidenceCoverageScore: pr.evidenceCoverageScore,
        externalDiscoveryStatus: pr.externalDiscoveryStatus,
        attributes: typeof pr.attributesJson === 'string' ? JSON.parse(pr.attributesJson) : pr.attributesJson || {},
        variants: varRes.rows.map((vr: any) => ({
          id: vr.id,
          sku: vr.sku,
          title: vr.title,
          barcode: vr.barcode,
          price: vr.price !== null ? parseFloat(vr.price) : null,
          inventoryCount: vr.inventoryCount,
          attributes: typeof vr.attributesJson === 'string' ? JSON.parse(vr.attributesJson) : vr.attributesJson || {},
        })),
        offers: [],
        evidenceDocuments: [evidence],
        findingsCount: pr.findingsCount,
        lastAudited: pr.lastAudited,
      };
    }

    return {
      evidence,
      productId: r.productId,
      product,
    };
  }

  async reviewEvidenceDocument(params: {
    workspaceId: string;
    evidenceId: string;
    decision: 'approved' | 'rejected';
    reviewerId: string;
    reviewerRole: string;
    principalType?: ReviewerPrincipalType;
    authMethod?: string;
    claimedReviewerId?: string;
    reason?: string;
    verificationSource?: 'server_reviewer';
  }): Promise<{ evidence: EvidenceDocument; auditEntry: EvidenceReviewAuditEntry; catalogVersion?: number }> {
    return this.withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('aixshop_cat'), hashtext($1))`, [params.workspaceId]);

      await client.query(
        `SELECT id FROM stores WHERE workspace_id = $1 FOR UPDATE`,
        [params.workspaceId]
      );

      const eviRes = await client.query<any>(
        `SELECT
          id,
          product_id AS "productId",
          title,
          type,
          issuer,
          date_verified AS "dateVerified",
          url,
          status,
          evidence_purpose AS "evidencePurpose",
          verification_source AS "verificationSource",
          external_verification_status AS "externalVerificationStatus",
          submitted_by_user_id AS "submittedByUserId",
          reviewed_by AS "verifiedBy",
          reviewer_principal_type AS "reviewerPrincipalType",
          reviewer_auth_method AS "reviewerAuthMethod",
          reviewed_at AS "reviewedAt",
          decision,
          decision_reason AS "decisionReason",
          integrity_hash AS "integrityHash",
          created_at AS "createdAt"
         FROM evidence_documents
         WHERE workspace_id = $1 AND id = $2
         FOR UPDATE`,
        [params.workspaceId, params.evidenceId]
      );

      if (eviRes.rows.length === 0) {
        const err: any = new Error(`Evidence document "${params.evidenceId}" not found in workspace ${params.workspaceId}`);
        err.statusCode = 404;
        err.code = 'EVIDENCE_NOT_FOUND';
        throw err;
      }

      const row = eviRes.rows[0];
      const existingDoc: EvidenceDocument = {
        id: row.id,
        title: row.title,
        type: row.type,
        issuer: row.issuer,
        dateVerified: row.dateVerified,
        url: row.url || undefined,
        status: row.status,
        evidencePurpose: row.evidencePurpose || 'general',
        verificationSource: row.verificationSource || 'client_submission',
        externalVerificationStatus: row.externalVerificationStatus || 'not_externally_verified',
        submittedByUserId: row.submittedByUserId || undefined,
        verifiedBy: row.verifiedBy || undefined,
        reviewerPrincipalType: row.reviewerPrincipalType || undefined,
        reviewerAuthMethod: row.reviewerAuthMethod || undefined,
        reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : undefined,
        decision: row.decision || undefined,
        decisionReason: row.decisionReason || undefined,
        integrityHash: row.integrityHash || undefined,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
      };

      const expectedHash = computeEvidenceIntegrityHash(params.workspaceId, row.productId, existingDoc);
      if (existingDoc.integrityHash && existingDoc.integrityHash !== expectedHash) {
        const err: any = new Error(
          `Evidence document "${params.evidenceId}" integrity hash mismatch: content may have been altered.`
        );
        err.statusCode = 409;
        err.code = 'EVIDENCE_INTEGRITY_MISMATCH';
        throw err;
      }

      const nowIso = new Date().toISOString();
      const source: 'server_reviewer' = 'server_reviewer';
      const externalStatus: ExternalVerificationStatus =
        params.decision === 'approved' ? 'reviewer_verified' : 'not_externally_verified';
      const principalType: ReviewerPrincipalType = params.principalType || 'service_principal';
      const authMethod = params.authMethod || 'platform_service_secret';
      const nextStatus = params.decision === 'approved' ? 'verified' : 'rejected';
      const effectiveDateVerified = existingDoc.dateVerified || nowIso;
      const updatedIntegrityHash = computeEvidenceIntegrityHash(params.workspaceId, row.productId, {
        ...existingDoc,
        dateVerified: effectiveDateVerified,
      });

      await client.query(
        `UPDATE evidence_documents
         SET status = $3,
             decision = $4,
             decision_reason = $5,
             verification_source = $6,
             external_verification_status = $7,
             reviewed_by = $8,
             reviewer_principal_type = $9,
             reviewer_auth_method = $10,
             reviewed_at = $11::timestamptz,
             date_verified = $12,
             integrity_hash = $13
         WHERE workspace_id = $1 AND id = $2`,
        [
          params.workspaceId,
          params.evidenceId,
          nextStatus,
          params.decision,
          params.reason || null,
          source,
          externalStatus,
          params.reviewerId,
          principalType,
          authMethod,
          nowIso,
          effectiveDateVerified,
          updatedIntegrityHash,
        ]
      );

      const verRes = await client.query<{ catalog_version: number }>(
        `UPDATE stores SET catalog_version = COALESCE(catalog_version, 1) + 1, updated_at = NOW() WHERE workspace_id = $1 RETURNING catalog_version`,
        [params.workspaceId]
      );

      const updatedDoc: EvidenceDocument = {
        ...existingDoc,
        status: nextStatus,
        decision: params.decision,
        decisionReason: params.reason,
        verificationSource: source,
        externalVerificationStatus: externalStatus,
        verifiedBy: params.reviewerId,
        reviewerPrincipalType: principalType,
        reviewerAuthMethod: authMethod,
        reviewedAt: nowIso,
        dateVerified: effectiveDateVerified,
        integrityHash: updatedIntegrityHash,
      };

      const auditEntry: EvidenceReviewAuditEntry = {
        id: `evlog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        workspaceId: params.workspaceId,
        evidenceId: existingDoc.id,
        productId: row.productId,
        action: params.decision === 'approved' ? 'approved' : 'rejected',
        decision: params.decision,
        reviewerId: params.reviewerId,
        reviewerRole: params.reviewerRole,
        principalType,
        authMethod,
        reason: params.reason,
        integrityHash: updatedIntegrityHash,
        metadata: {
          evidencePurpose: updatedDoc.evidencePurpose || 'general',
          verificationSource: source,
          externalVerificationStatus: externalStatus,
          previousStatus: existingDoc.status,
          ...(params.claimedReviewerId ? { claimedReviewerId: params.claimedReviewerId } : {}),
        },
        createdAt: nowIso,
      };

      await client.query(
        `INSERT INTO evidence_review_audit_log (
           id, workspace_id, evidence_id, product_id, action, decision, reviewer_id, reviewer_role, principal_type, auth_method, reason, integrity_hash, metadata_json, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::timestamptz)`,
        [
          auditEntry.id,
          auditEntry.workspaceId,
          auditEntry.evidenceId,
          auditEntry.productId,
          auditEntry.action,
          auditEntry.decision,
          auditEntry.reviewerId || null,
          auditEntry.reviewerRole || null,
          principalType,
          authMethod,
          auditEntry.reason || null,
          auditEntry.integrityHash,
          JSON.stringify(auditEntry.metadata || {}),
          nowIso,
        ]
      );

      return {
        evidence: updatedDoc,
        auditEntry,
        catalogVersion: Number(verRes.rows[0]?.catalog_version ?? 1),
      };
    });
  }

  async recordExternalRegistryVerification(params: {
    workspaceId: string;
    evidenceId: string;
    initiatedByReviewerId: string;
    initiatedByPrincipalType: ReviewerPrincipalType;
    initiatedByAuthMethod: string;
    claimedReviewerId?: string;
    evaluation: ExternalRegistryVerificationEvaluation;
  }): Promise<{ evidence: EvidenceDocument; auditEntry: EvidenceReviewAuditEntry; catalogVersion?: number }> {
    return this.withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('aixshop_cat'), hashtext($1))`, [params.workspaceId]);

      await client.query(
        `SELECT id FROM stores WHERE workspace_id = $1 FOR UPDATE`,
        [params.workspaceId]
      );

      const eviRes = await client.query<any>(
        `SELECT
          id,
          product_id AS "productId",
          title,
          type,
          issuer,
          date_verified AS "dateVerified",
          url,
          status,
          evidence_purpose AS "evidencePurpose",
          verification_source AS "verificationSource",
          external_verification_status AS "externalVerificationStatus",
          submitted_by_user_id AS "submittedByUserId",
          reviewed_by AS "verifiedBy",
          reviewer_principal_type AS "reviewerPrincipalType",
          reviewer_auth_method AS "reviewerAuthMethod",
          reviewed_at AS "reviewedAt",
          decision,
          decision_reason AS "decisionReason",
          external_provider_name AS "externalProviderName",
          external_provider_ref AS "externalProviderRef",
          external_request_at AS "externalRequestAt",
          external_response_at AS "externalResponseAt",
          external_verification_result AS "externalVerificationResult",
          external_verification_evidence_json AS "externalVerificationEvidence",
          integrity_hash AS "integrityHash",
          created_at AS "createdAt"
         FROM evidence_documents
         WHERE workspace_id = $1 AND id = $2
         FOR UPDATE`,
        [params.workspaceId, params.evidenceId]
      );

      if (eviRes.rows.length === 0) {
        const err: any = new Error(`Evidence document "${params.evidenceId}" not found in workspace ${params.workspaceId}`);
        err.statusCode = 404;
        err.code = 'EVIDENCE_NOT_FOUND';
        throw err;
      }

      const row = eviRes.rows[0];
      const existingDoc: EvidenceDocument = {
        id: row.id,
        title: row.title,
        type: row.type,
        issuer: row.issuer,
        dateVerified: row.dateVerified,
        url: row.url || undefined,
        status: row.status,
        evidencePurpose: row.evidencePurpose || 'general',
        verificationSource: row.verificationSource || 'client_submission',
        externalVerificationStatus: row.externalVerificationStatus || 'not_externally_verified',
        submittedByUserId: row.submittedByUserId || undefined,
        verifiedBy: row.verifiedBy || undefined,
        reviewerPrincipalType: row.reviewerPrincipalType || undefined,
        reviewerAuthMethod: row.reviewerAuthMethod || undefined,
        reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : undefined,
        decision: row.decision || undefined,
        decisionReason: row.decisionReason || undefined,
        externalProviderName: row.externalProviderName || undefined,
        externalProviderRef: row.externalProviderRef || undefined,
        externalRequestAt: row.externalRequestAt ? new Date(row.externalRequestAt).toISOString() : undefined,
        externalResponseAt: row.externalResponseAt ? new Date(row.externalResponseAt).toISOString() : undefined,
        externalVerificationResult: row.externalVerificationResult || undefined,
        externalVerificationEvidence: row.externalVerificationEvidence
          ? typeof row.externalVerificationEvidence === 'string'
            ? JSON.parse(row.externalVerificationEvidence)
            : row.externalVerificationEvidence
          : undefined,
        integrityHash: row.integrityHash || undefined,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : undefined,
      };

      const expectedHash = computeEvidenceIntegrityHash(params.workspaceId, row.productId, existingDoc);
      if (existingDoc.integrityHash && existingDoc.integrityHash !== expectedHash) {
        const err: any = new Error(
          `Evidence document "${params.evidenceId}" integrity hash mismatch: content may have been altered.`
        );
        err.statusCode = 409;
        err.code = 'EVIDENCE_INTEGRITY_MISMATCH';
        throw err;
      }

      const nowIso = new Date().toISOString();
      const evalRes = params.evaluation;
      let updatedDoc: EvidenceDocument;

      if (evalRes.verified) {
        const effectiveDateVerified = existingDoc.dateVerified || nowIso;
        const updatedIntegrityHash = computeEvidenceIntegrityHash(params.workspaceId, row.productId, {
          ...existingDoc,
          dateVerified: effectiveDateVerified,
        });
        updatedDoc = {
          ...existingDoc,
          status: 'verified',
          decision: 'approved',
          decisionReason: evalRes.reason,
          verificationSource: 'external_registry',
          externalVerificationStatus: 'external_registry_verified',
          verifiedBy: evalRes.providerName || params.initiatedByReviewerId,
          reviewerPrincipalType: 'external_registry_provider',
          reviewerAuthMethod: 'external_registry_adapter',
          reviewedAt: evalRes.responseAt || nowIso,
          dateVerified: effectiveDateVerified,
          externalProviderName: evalRes.providerName,
          externalProviderRef: evalRes.providerRef,
          externalRequestAt: evalRes.requestAt,
          externalResponseAt: evalRes.responseAt,
          externalVerificationResult: evalRes.outcome,
          externalVerificationEvidence: evalRes.sanitizedEvidence,
          integrityHash: updatedIntegrityHash,
        };

        await client.query(
          `UPDATE evidence_documents
           SET status = 'verified',
               decision = 'approved',
               decision_reason = $3,
               verification_source = 'external_registry',
               external_verification_status = 'external_registry_verified',
               reviewed_by = $4,
               reviewer_principal_type = 'external_registry_provider',
               reviewer_auth_method = 'external_registry_adapter',
               reviewed_at = $5::timestamptz,
               date_verified = $6,
               external_provider_name = $7,
               external_provider_ref = $8,
               external_request_at = $9::timestamptz,
               external_response_at = $10::timestamptz,
               external_verification_result = $11,
               external_verification_evidence_json = $12::jsonb,
               integrity_hash = $13
           WHERE workspace_id = $1 AND id = $2`,
          [
            params.workspaceId,
            params.evidenceId,
            evalRes.reason,
            updatedDoc.verifiedBy,
            updatedDoc.reviewedAt,
            effectiveDateVerified,
            evalRes.providerName || null,
            evalRes.providerRef || null,
            evalRes.requestAt || nowIso,
            evalRes.responseAt || nowIso,
            evalRes.outcome,
            JSON.stringify(evalRes.sanitizedEvidence || {}),
            updatedIntegrityHash,
          ]
        );
      } else {
        const nextExtStatus: ExternalVerificationStatus =
          existingDoc.externalVerificationStatus === 'reviewer_verified'
            ? 'reviewer_verified'
            : 'not_externally_verified';
        updatedDoc = {
          ...existingDoc,
          externalProviderName: evalRes.providerName || existingDoc.externalProviderName,
          externalProviderRef: evalRes.providerRef || existingDoc.externalProviderRef,
          externalRequestAt: evalRes.requestAt || nowIso,
          externalResponseAt: evalRes.responseAt || nowIso,
          externalVerificationResult: evalRes.outcome,
          externalVerificationStatus: nextExtStatus,
        };

        await client.query(
          `UPDATE evidence_documents
           SET external_provider_name = COALESCE($3, external_provider_name),
               external_provider_ref = COALESCE($4, external_provider_ref),
               external_request_at = $5::timestamptz,
               external_response_at = $6::timestamptz,
               external_verification_result = $7,
               external_verification_status = $8
           WHERE workspace_id = $1 AND id = $2`,
          [
            params.workspaceId,
            params.evidenceId,
            evalRes.providerName || null,
            evalRes.providerRef || null,
            evalRes.requestAt || nowIso,
            evalRes.responseAt || nowIso,
            evalRes.outcome,
            nextExtStatus,
          ]
        );
      }

      const verRes = await client.query<{ catalog_version: number }>(
        `UPDATE stores SET catalog_version = COALESCE(catalog_version, 1) + 1, updated_at = NOW() WHERE workspace_id = $1 RETURNING catalog_version`,
        [params.workspaceId]
      );

      const auditAction = evalRes.verified ? 'external_verified' : 'external_verification_failed';
      const auditPrincipalType: ReviewerPrincipalType = evalRes.verified
        ? 'external_registry_provider'
        : params.initiatedByPrincipalType;
      const auditAuthMethod = evalRes.verified ? 'external_registry_adapter' : params.initiatedByAuthMethod;

      const auditEntry: EvidenceReviewAuditEntry = {
        id: `evlog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        workspaceId: params.workspaceId,
        evidenceId: existingDoc.id,
        productId: row.productId,
        action: auditAction,
        decision: updatedDoc.decision || 'pending',
        reviewerId: params.initiatedByReviewerId,
        reviewerRole: 'platform_reviewer',
        principalType: auditPrincipalType,
        authMethod: auditAuthMethod,
        reason: evalRes.reason,
        integrityHash: updatedDoc.integrityHash || expectedHash,
        metadata: {
          evidencePurpose: updatedDoc.evidencePurpose || 'general',
          verificationSource: updatedDoc.verificationSource || 'client_submission',
          externalVerificationStatus: updatedDoc.externalVerificationStatus,
          externalOutcome: evalRes.outcome,
          externalProviderName: evalRes.providerName || null,
          externalProviderRef: evalRes.providerRef || null,
          externalRequestAt: evalRes.requestAt || null,
          externalResponseAt: evalRes.responseAt || null,
          initiatedByReviewerId: params.initiatedByReviewerId,
          ...(params.claimedReviewerId ? { claimedReviewerId: params.claimedReviewerId } : {}),
        },
        createdAt: nowIso,
      };

      await client.query(
        `INSERT INTO evidence_review_audit_log (
           id, workspace_id, evidence_id, product_id, action, decision, reviewer_id, reviewer_role, principal_type, auth_method, reason, integrity_hash, metadata_json, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::timestamptz)`,
        [
          auditEntry.id,
          auditEntry.workspaceId,
          auditEntry.evidenceId,
          auditEntry.productId,
          auditEntry.action,
          auditEntry.decision,
          auditEntry.reviewerId || null,
          auditEntry.reviewerRole || null,
          auditPrincipalType,
          auditAuthMethod,
          auditEntry.reason || null,
          auditEntry.integrityHash,
          JSON.stringify(auditEntry.metadata || {}),
          nowIso,
        ]
      );

      return {
        evidence: updatedDoc,
        auditEntry,
        catalogVersion: Number(verRes.rows[0]?.catalog_version ?? 1),
      };
    });
  }

  async getPlatformReviewerGrant(userId: string): Promise<{
    platformRole: 'none' | 'platform_reviewer';
    scopes: string[];
    revokedAt?: string | null;
  } | null> {
    const res = await this.query<any>(
      `SELECT platform_role AS "platformRole", platform_reviewer_scopes_json AS "scopes", platform_reviewer_revoked_at AS "revokedAt"
       FROM users
       WHERE id = $1`,
      [userId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    const scopesRaw = typeof r.scopes === 'string' ? JSON.parse(r.scopes) : r.scopes;
    return {
      platformRole: r.platformRole === 'platform_reviewer' ? 'platform_reviewer' : 'none',
      scopes: Array.isArray(scopesRaw) ? scopesRaw : [],
      revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
    };
  }

  async setPlatformReviewerGrant(params: {
    userId: string;
    platformRole: 'none' | 'platform_reviewer';
    scopes?: string[];
    revokedAt?: string | null;
  }): Promise<void> {
    await this.query(
      `UPDATE users
       SET platform_role = $2,
           platform_reviewer_scopes_json = $3::jsonb,
           platform_reviewer_revoked_at = $4::timestamptz,
           updated_at = NOW()
       WHERE id = $1`,
      [
        params.userId,
        params.platformRole,
        JSON.stringify(params.scopes || []),
        params.revokedAt ?? null,
      ]
    );
  }

  async listReviewerServicePrincipals(): Promise<ReviewerServicePrincipalRecord[]> {
    const res = await this.query<any>(
      `SELECT id, principal_id AS "principalId", display_name AS "displayName", secret_hash AS "secretHash",
              key_id AS "keyId", scopes_json AS "scopes", status, expires_at AS "expiresAt",
              revoked_at AS "revokedAt", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM reviewer_service_principals
       ORDER BY created_at DESC`
    );
    return res.rows.map((r: any) => ({
      id: r.id,
      principalId: r.principalId,
      displayName: r.displayName,
      secretHash: r.secretHash,
      keyId: r.keyId,
      scopes: typeof r.scopes === 'string' ? JSON.parse(r.scopes) : Array.isArray(r.scopes) ? r.scopes : [],
      status: r.status === 'revoked' ? 'revoked' : 'active',
      expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
      revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : undefined,
    }));
  }

  async saveReviewerServicePrincipal(principal: ReviewerServicePrincipalRecord): Promise<ReviewerServicePrincipalRecord> {
    const res = await this.query<any>(
      `INSERT INTO reviewer_service_principals (
         id, principal_id, display_name, secret_hash, key_id, scopes_json, status, expires_at, revoked_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz, $9::timestamptz, NOW(), NOW())
       ON CONFLICT (principal_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         secret_hash = EXCLUDED.secret_hash,
         key_id = EXCLUDED.key_id,
         scopes_json = EXCLUDED.scopes_json,
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         revoked_at = EXCLUDED.revoked_at,
         updated_at = NOW()
       RETURNING id, principal_id AS "principalId", display_name AS "displayName", secret_hash AS "secretHash",
                 key_id AS "keyId", scopes_json AS "scopes", status, expires_at AS "expiresAt",
                 revoked_at AS "revokedAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        principal.id,
        principal.principalId,
        principal.displayName,
        principal.secretHash,
        principal.keyId,
        JSON.stringify(principal.scopes || ['evidence:review']),
        principal.status,
        principal.expiresAt || null,
        principal.revokedAt || null,
      ]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      principalId: r.principalId,
      displayName: r.displayName,
      secretHash: r.secretHash,
      keyId: r.keyId,
      scopes: typeof r.scopes === 'string' ? JSON.parse(r.scopes) : Array.isArray(r.scopes) ? r.scopes : [],
      status: r.status === 'revoked' ? 'revoked' : 'active',
      expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
      revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : undefined,
    };
  }

  async revokeReviewerServicePrincipal(principalId: string): Promise<void> {
    await this.query(
      `UPDATE reviewer_service_principals
       SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
       WHERE principal_id = $1`,
      [principalId]
    );
  }

  async getEvidenceReviewAuditLog(workspaceId: string, evidenceId?: string): Promise<EvidenceReviewAuditEntry[]> {
    const res = evidenceId
      ? await this.query<any>(
          `SELECT id, workspace_id AS "workspaceId", evidence_id AS "evidenceId", product_id AS "productId",
                  action, decision, reviewer_id AS "reviewerId", reviewer_role AS "reviewerRole",
                  principal_type AS "principalType", auth_method AS "authMethod",
                  reason, integrity_hash AS "integrityHash", metadata_json AS "metadata", created_at AS "createdAt"
           FROM evidence_review_audit_log
           WHERE workspace_id = $1 AND evidence_id = $2
           ORDER BY created_at DESC`,
          [workspaceId, evidenceId]
        )
      : await this.query<any>(
          `SELECT id, workspace_id AS "workspaceId", evidence_id AS "evidenceId", product_id AS "productId",
                  action, decision, reviewer_id AS "reviewerId", reviewer_role AS "reviewerRole",
                  principal_type AS "principalType", auth_method AS "authMethod",
                  reason, integrity_hash AS "integrityHash", metadata_json AS "metadata", created_at AS "createdAt"
           FROM evidence_review_audit_log
           WHERE workspace_id = $1
           ORDER BY created_at DESC`,
          [workspaceId]
        );

    return res.rows.map((r: any) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      evidenceId: r.evidenceId,
      productId: r.productId,
      action: r.action,
      decision: r.decision,
      reviewerId: r.reviewerId || undefined,
      reviewerRole: r.reviewerRole || undefined,
      principalType: r.principalType || undefined,
      authMethod: r.authMethod || undefined,
      reason: r.reason || undefined,
      integrityHash: r.integrityHash,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata || {},
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  }

  private async upsertShopifyProductProvenanceWithClient(
    queryable: { query: (text: string, params?: any[]) => Promise<any> },
    record: ShopifyProductProvenanceRecord
  ): Promise<void> {
    await queryable.query(
      `INSERT INTO shopify_product_provenance (
         workspace_id, product_id, shop_domain, shopify_product_id, shopify_gid,
         is_gift_card, source_type, shopify_updated_at, verified_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()), NOW(), NOW())
       ON CONFLICT (workspace_id, product_id) DO UPDATE SET
         shop_domain = EXCLUDED.shop_domain,
         shopify_product_id = EXCLUDED.shopify_product_id,
         shopify_gid = EXCLUDED.shopify_gid,
         is_gift_card = EXCLUDED.is_gift_card,
         source_type = EXCLUDED.source_type,
         shopify_updated_at = EXCLUDED.shopify_updated_at,
         verified_at = EXCLUDED.verified_at,
         updated_at = NOW()`,
      [
        record.workspaceId,
        record.productId,
        record.shopDomain,
        record.shopifyProductId,
        record.shopifyGid,
        record.isGiftCard,
        record.sourceType,
        record.shopifyUpdatedAt || null,
        record.verifiedAt || null,
      ]
    );
  }

  async upsertShopifyProductProvenance(record: ShopifyProductProvenanceRecord): Promise<void> {
    await this.upsertShopifyProductProvenanceWithClient(
      { query: (text: string, params?: any[]) => this.query(text, params) },
      record
    );
  }

  async getShopifyProductProvenance(workspaceId: string): Promise<ShopifyProductProvenanceRecord[]> {
    return this.getShopifyProductProvenanceWithClient(
      { query: (text: string, params?: any[]) => this.query(text, params) },
      workspaceId
    );
  }

  private async deleteShopifyProductProvenanceWithClient(
    queryable: { query: (text: string, params?: any[]) => Promise<any> },
    workspaceId: string,
    productId: string
  ): Promise<void> {
    await queryable.query(
      `DELETE FROM shopify_product_provenance WHERE workspace_id = $1 AND product_id = $2`,
      [workspaceId, productId]
    );
  }

  async deleteShopifyProductProvenance(workspaceId: string, productId: string): Promise<void> {
    await this.deleteShopifyProductProvenanceWithClient(
      { query: (text: string, params?: any[]) => this.query(text, params) },
      workspaceId,
      productId
    );
  }

  async commitShopifyCatalogSyncAtomic(params: {
    workspaceId: string;
    syncRunId: string;
    syncRunUpdates: Partial<import('../shopify/types').ShopifySyncRunRecord>;
    buildNextCatalog: (
      catalog: StoragePayloadV1,
      authoritativeStore: StoreProfile
    ) => Promise<{
      nextCatalog?: StoragePayloadV1;
      provenanceRecords: ShopifyProductProvenanceRecord[];
    }> | {
      nextCatalog?: StoragePayloadV1;
      provenanceRecords: ShopifyProductProvenanceRecord[];
    };
  }): Promise<{
    syncRun: import('../shopify/types').ShopifySyncRunRecord;
    catalogVersion?: number;
  }> {
    return this.withTransaction(async (client) => {
      const { storeId, authoritativeStore, catalog } = await this.lockStoreAndLoadCatalogForUpdate(
        client,
        params.workspaceId,
        { createStoreIfMissing: true }
      );

      const { nextCatalog, provenanceRecords } = await params.buildNextCatalog(catalog, authoritativeStore);

      let persistedVersion: number | undefined = catalog.catalogVersion;
      if (nextCatalog) {
        const proposedSkus = countCatalogSkus(nextCatalog.products);
        const quotaCheck = checkPlanQuota(authoritativeStore, [], proposedSkus);
        if (!quotaCheck.allowed) {
          throw new PlanQuotaExceededError(quotaCheck);
        }

        persistedVersion = await this.saveCatalogRows(client, params.workspaceId, nextCatalog, storeId, authoritativeStore);
        nextCatalog.catalogVersion = persistedVersion;
      }

      for (const provRecord of provenanceRecords) {
        await this.upsertShopifyProductProvenanceWithClient(client, provRecord);
      }

      const syncRun = await this.updateShopifySyncRunWithClient(
        client,
        params.syncRunId,
        params.workspaceId,
        params.syncRunUpdates
      );

      return { syncRun, catalogVersion: persistedVersion };
    });
  }

  async commitShopifyWebhookMutationAtomic<T = void>(params: {
    workspaceId: string;
    shopDomain: string;
    topic: string;
    eventId: string;
    leaseOwner?: string;
    defaultWebhookStatus: 'processed' | 'ignored';
    applyMutation: (
      catalog: StoragePayloadV1,
      authoritativeStore: StoreProfile,
      subscription: SubscriptionRecord | null
    ) => Promise<{
      nextCatalog?: StoragePayloadV1;
      nextStoreProfile?: StoreProfile;
      provenanceUpserts?: ShopifyProductProvenanceRecord[];
      provenanceDeletes?: string[];
      disconnectShopifyConnection?: boolean;
      webhookStatus?: 'processed' | 'ignored';
      webhookError?: string;
      result: T;
    }> | {
      nextCatalog?: StoragePayloadV1;
      nextStoreProfile?: StoreProfile;
      provenanceUpserts?: ShopifyProductProvenanceRecord[];
      provenanceDeletes?: string[];
      disconnectShopifyConnection?: boolean;
      webhookStatus?: 'processed' | 'ignored';
      webhookError?: string;
      result: T;
    };
  }): Promise<{
    result: T;
    catalogVersion?: number;
  }> {
    return this.withTransaction(async (client) => {
      const { storeId, authoritativeStore, catalog } = await this.lockStoreAndLoadCatalogForUpdate(
        client,
        params.workspaceId,
        { createStoreIfMissing: true }
      );

      const subRes = await client.query<any>(
        `SELECT id, workspace_id AS "workspaceId", provider, customer_id AS "customerId", subscription_id AS "subscriptionId",
                tier, status, current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd",
                cancel_at_period_end AS "cancelAtPeriodEnd", last_event_created AS "lastEventCreated",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM subscriptions WHERE workspace_id = $1 LIMIT 1`,
        [params.workspaceId]
      );
      const subscription: SubscriptionRecord | null = subRes.rows[0] || null;

      const mutation = await params.applyMutation(catalog, authoritativeStore, subscription);

      let persistedVersion: number | undefined = catalog.catalogVersion;
      if (mutation.disconnectShopifyConnection) {
        await client.query(
          `UPDATE shopify_connections
           SET status = 'disconnected',
               access_token_encrypted = '',
               refresh_token_encrypted = NULL,
               updated_at = NOW()
           WHERE workspace_id = $1`,
          [params.workspaceId]
        );
        if (mutation.nextStoreProfile) {
          await this.saveStoreProfileWithClient(client, params.workspaceId, mutation.nextStoreProfile);
        }
      } else if (mutation.nextCatalog) {
        const proposedSkus = countCatalogSkus(mutation.nextCatalog.products);
        const quotaCheck = checkPlanQuota(authoritativeStore, [], proposedSkus);
        if (!quotaCheck.allowed) {
          throw new PlanQuotaExceededError(quotaCheck);
        }

        persistedVersion = await this.saveCatalogRows(
          client,
          params.workspaceId,
          mutation.nextCatalog,
          storeId,
          authoritativeStore
        );
        mutation.nextCatalog.catalogVersion = persistedVersion;
      }

      for (const provRecord of mutation.provenanceUpserts || []) {
        await this.upsertShopifyProductProvenanceWithClient(client, provRecord);
      }

      for (const productId of mutation.provenanceDeletes || []) {
        await this.deleteShopifyProductProvenanceWithClient(client, params.workspaceId, productId);
      }

      await this.updateShopifyWebhookEventStatusWithClient(
        client,
        params.eventId,
        params.shopDomain,
        params.topic,
        mutation.webhookStatus ?? params.defaultWebhookStatus,
        mutation.webhookError,
        params.leaseOwner
      );

      return { result: mutation.result, catalogVersion: persistedVersion };
    });
  }

  private mapGuestTransferAuthRow(r: any): GuestTransferAuthorizationRecord {
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      userId: r.user_id,
      tokenHash: r.token_hash,
      idempotencyKey: r.idempotency_key,
      payloadSha256: r.payload_sha256,
      conflictStrategy: r.conflict_strategy,
      status: r.status,
      expiresAt: new Date(r.expires_at).toISOString(),
      committedAt: r.committed_at ? new Date(r.committed_at).toISOString() : null,
      resultSummary: r.result_summary_json
        ? typeof r.result_summary_json === 'string'
          ? JSON.parse(r.result_summary_json)
          : r.result_summary_json
        : null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  async createGuestTransferAuthorization(
    record: GuestTransferAuthorizationRecord
  ): Promise<GuestTransferAuthorizationRecord> {
    return this.withTransaction(async (client) => {
      await client.query(
        `DELETE FROM guest_transfer_authorizations
         WHERE workspace_id = $1 AND user_id = $2 AND idempotency_key = $3 AND status <> 'committed'`,
        [record.workspaceId, record.userId, record.idempotencyKey]
      );
      const res = await client.query<any>(
        `INSERT INTO guest_transfer_authorizations (
           id, workspace_id, user_id, token_hash, idempotency_key, payload_sha256,
           conflict_strategy, status, expires_at, committed_at, result_summary_json, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::jsonb, NOW(), NOW())
         RETURNING *`,
        [
          record.id,
          record.workspaceId,
          record.userId,
          record.tokenHash,
          record.idempotencyKey,
          record.payloadSha256,
          record.conflictStrategy,
          record.status,
          record.expiresAt,
          record.committedAt || null,
          record.resultSummary ? JSON.stringify(record.resultSummary) : null,
        ]
      );
      return this.mapGuestTransferAuthRow(res.rows[0]);
    });
  }

  async getGuestTransferAuthorizationByTokenHash(
    tokenHash: string
  ): Promise<GuestTransferAuthorizationRecord | null> {
    const res = await this.query<any>(
      `SELECT * FROM guest_transfer_authorizations WHERE token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    if (res.rows.length === 0) return null;
    return this.mapGuestTransferAuthRow(res.rows[0]);
  }

  async getGuestTransferAuthorizationByIdempotencyKey(
    workspaceId: string,
    userId: string,
    idempotencyKey: string
  ): Promise<GuestTransferAuthorizationRecord | null> {
    const res = await this.query<any>(
      `SELECT * FROM guest_transfer_authorizations
       WHERE workspace_id = $1 AND user_id = $2 AND idempotency_key = $3
       LIMIT 1`,
      [workspaceId, userId, idempotencyKey]
    );
    if (res.rows.length === 0) return null;
    return this.mapGuestTransferAuthRow(res.rows[0]);
  }

  async markGuestTransferAuthorizationExpired(id: string): Promise<void> {
    await this.query(
      `UPDATE guest_transfer_authorizations
       SET status = 'expired', updated_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [id]
    );
  }

  async commitGuestTransferAtomic(params: {
    authorizationId: string;
    workspaceId: string;
    userId: string;
    payloadSha256: string;
    conflictStrategy: GuestTransferConflictStrategy;
    guestPayload: StoragePayloadV1;
    buildMergedCatalog: (ctx: {
      existingCatalog: StoragePayloadV1 | null;
      authoritativeStore: StoreProfile;
      subscription: SubscriptionRecord | null;
      catalogVersionBefore: number;
    }) => {
      mergedPayload: StoragePayloadV1;
      summary: GuestTransferCommitResult;
      importedCount: number;
      skippedCount: number;
      conflictsCount: number;
    };
  }): Promise<GuestTransferCommitResult> {
    return this.withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('aixshop_cat'), hashtext($1))`, [
        params.workspaceId,
      ]);

      const authRes = await client.query<any>(
        `SELECT * FROM guest_transfer_authorizations WHERE id = $1 FOR UPDATE`,
        [params.authorizationId]
      );
      if (authRes.rows.length === 0) {
        throw new GuestTransferError('Invalid guest transfer authorization.', 'TRANSFER_AUTHORIZATION_INVALID', 403);
      }
      const auth = this.mapGuestTransferAuthRow(authRes.rows[0]);
      if (auth.workspaceId !== params.workspaceId || auth.userId !== params.userId) {
        throw new GuestTransferError(
          'Forbidden: guest transfer authorization is bound to a different user or workspace.',
          'TRANSFER_TENANT_MISMATCH',
          403
        );
      }
      if (auth.status === 'committed') {
        if (auth.payloadSha256 === params.payloadSha256 && auth.resultSummary) {
          return { ...auth.resultSummary, idempotentReplay: true };
        }
        throw new GuestTransferError(
          'Single-use guest transfer authorization has already been consumed.',
          'TRANSFER_TOKEN_ALREADY_USED',
          409
        );
      }
      if (auth.status === 'expired' || new Date(auth.expiresAt).getTime() <= Date.now()) {
        await client.query(
          `UPDATE guest_transfer_authorizations SET status = 'expired', updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
          [auth.id]
        );
        throw new GuestTransferError('Guest transfer authorization has expired.', 'TRANSFER_AUTHORIZATION_EXPIRED', 410);
      }

      const storeId = `store_${params.workspaceId}`;
      let storeRes = await client.query<any>(
        `SELECT id, tier, sku_limit, name, domain, website_url, platform, source_classification, source_metadata_json,
                evidence_coverage_avg, last_audit_date, shopify_connected, shopify_shop_domain, currency,
                sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json, catalog_version
         FROM stores WHERE workspace_id = $1 FOR UPDATE`,
        [params.workspaceId]
      );
      if (storeRes.rows.length === 0) {
        await client.query(
          `INSERT INTO stores (id, workspace_id, name, domain, currency, sku_count, catalog_completeness_avg, truth_boundary_strictness, tier, connectors_json, website_url, source_classification, shopify_connected, created_at, updated_at)
           VALUES ($1, $2, $3, '', 'USD', 0, 0, 'standard', 'Free Audit', '[]'::jsonb, '', 'unconfigured', FALSE, NOW(), NOW())
           ON CONFLICT (id) DO NOTHING`,
          [storeId, params.workspaceId, `${params.workspaceId} Store`]
        );
        storeRes = await client.query<any>(
          `SELECT id, tier, sku_limit, name, domain, website_url, platform, source_classification, source_metadata_json,
                  evidence_coverage_avg, last_audit_date, shopify_connected, shopify_shop_domain, currency,
                  sku_count, catalog_completeness_avg, truth_boundary_strictness, connectors_json, catalog_version
           FROM stores WHERE workspace_id = $1 FOR UPDATE`,
          [params.workspaceId]
        );
      }

      const lockedRow = storeRes.rows[0];
      const catalogVersionBefore = Number(lockedRow?.catalog_version ?? 1);
      const lockedDomain = lockedRow?.domain ?? '';
      const lockedMeta = lockedRow?.source_metadata_json
        ? typeof lockedRow.source_metadata_json === 'string'
          ? JSON.parse(lockedRow.source_metadata_json)
          : lockedRow.source_metadata_json
        : undefined;
      const authoritativeStore: StoreProfile = {
        name: lockedRow?.name || `${params.workspaceId} Store`,
        domain: lockedDomain,
        websiteUrl: lockedRow?.website_url ?? lockedDomain,
        ...(lockedRow?.platform ? { platform: lockedRow.platform } : {}),
        sourceClassification:
          lockedRow?.source_classification || (lockedRow?.shopify_connected ? 'shopify_oauth' : 'unconfigured'),
        ...(lockedMeta && Object.keys(lockedMeta).length > 0 ? { sourceMetadata: lockedMeta } : {}),
        shopifyConnected: Boolean(lockedRow?.shopify_connected),
        ...(lockedRow?.shopify_shop_domain ? { shopifyShopDomain: lockedRow.shopify_shop_domain } : {}),
        currency: lockedRow?.currency || 'USD',
        skuCount: lockedRow?.sku_count || 0,
        catalogCompletenessAvg: lockedRow?.catalog_completeness_avg || 0,
        truthBoundaryStrictness: (lockedRow?.truth_boundary_strictness || 'standard') as any,
        tier: (lockedRow?.tier || 'Free Audit') as any,
        skuLimit: lockedRow?.sku_limit !== null && lockedRow?.sku_limit !== undefined ? lockedRow.sku_limit : undefined,
        connectors:
          typeof lockedRow?.connectors_json === 'string'
            ? JSON.parse(lockedRow.connectors_json)
            : lockedRow?.connectors_json || [],
      };

      const subRes = await client.query<any>(
        `SELECT id, workspace_id AS "workspaceId", provider, customer_id AS "customerId", subscription_id AS "subscriptionId",
                tier, status, current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd",
                cancel_at_period_end AS "cancelAtPeriodEnd", last_event_created AS "lastEventCreated",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM subscriptions WHERE workspace_id = $1 LIMIT 1`,
        [params.workspaceId]
      );
      const subscription: SubscriptionRecord | null = subRes.rows[0] || null;
      const existingCatalog = await this.loadCatalogRows(client, params.workspaceId, authoritativeStore);

      const built = params.buildMergedCatalog({
        existingCatalog,
        authoritativeStore,
        subscription,
        catalogVersionBefore,
      });

      const nextVersion = await this.saveCatalogRows(
        client,
        params.workspaceId,
        built.mergedPayload,
        storeId,
        authoritativeStore
      );

      const summary: GuestTransferCommitResult = {
        ...built.summary,
        catalogVersion: nextVersion,
      };

      const auditId = `gta_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await client.query(
        `INSERT INTO guest_transfer_audit_log (
           id, transfer_id, workspace_id, user_id, outcome, conflict_strategy,
           imported_count, skipped_count, conflicts_count, catalog_version_before, catalog_version_after,
           details_json, created_at
         ) VALUES ($1, $2, $3, $4, 'committed', $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())`,
        [
          auditId,
          auth.id,
          params.workspaceId,
          params.userId,
          params.conflictStrategy,
          built.importedCount,
          built.skippedCount,
          built.conflictsCount,
          catalogVersionBefore,
          nextVersion,
          JSON.stringify({
            renamedCount: summary.renamedCount,
            preservedSourceClassifications: summary.preservedSourceClassifications,
            totalWorkspaceProducts: summary.totalWorkspaceProducts,
          }),
        ]
      );

      await client.query(
        `UPDATE guest_transfer_authorizations
         SET status = 'committed',
             conflict_strategy = $2,
             committed_at = COALESCE($3::timestamptz, NOW()),
             result_summary_json = $4::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [auth.id, params.conflictStrategy, summary.committedAt, JSON.stringify(summary)]
      );

      return summary;
    });
  }

  async recordGuestTransferAudit(record: GuestTransferAuditRecord): Promise<void> {
    await this.query(
      `INSERT INTO guest_transfer_audit_log (
         id, transfer_id, workspace_id, user_id, outcome, conflict_strategy,
         imported_count, skipped_count, conflicts_count, catalog_version_before, catalog_version_after,
         details_json, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, COALESCE($13::timestamptz, NOW()))`,
      [
        record.id,
        record.transferId,
        record.workspaceId,
        record.userId,
        record.outcome,
        record.conflictStrategy,
        record.importedCount,
        record.skippedCount,
        record.conflictsCount,
        record.catalogVersionBefore ?? null,
        record.catalogVersionAfter ?? null,
        JSON.stringify(record.details || {}),
        record.createdAt || null,
      ]
    );
  }

  async getGuestTransferAuditLog(workspaceId: string): Promise<GuestTransferAuditRecord[]> {
    const res = await this.query<any>(
      `SELECT id, transfer_id AS "transferId", workspace_id AS "workspaceId", user_id AS "userId",
              outcome, conflict_strategy AS "conflictStrategy", imported_count AS "importedCount",
              skipped_count AS "skippedCount", conflicts_count AS "conflictsCount",
              catalog_version_before AS "catalogVersionBefore", catalog_version_after AS "catalogVersionAfter",
              details_json AS "details", created_at AS "createdAt"
       FROM guest_transfer_audit_log
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [workspaceId]
    );
    return res.rows.map((r: any) => ({
      id: r.id,
      transferId: r.transferId,
      workspaceId: r.workspaceId,
      userId: r.userId,
      outcome: r.outcome,
      conflictStrategy: r.conflictStrategy,
      importedCount: Number(r.importedCount || 0),
      skippedCount: Number(r.skippedCount || 0),
      conflictsCount: Number(r.conflictsCount || 0),
      catalogVersionBefore: r.catalogVersionBefore !== null ? Number(r.catalogVersionBefore) : null,
      catalogVersionAfter: r.catalogVersionAfter !== null ? Number(r.catalogVersionAfter) : null,
      details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details || {},
      createdAt: new Date(r.createdAt).toISOString(),
    }));
  }

  async deleteAccountAndOwnedWorkspaces(userId: string): Promise<DeleteAccountResult> {
    return this.withTransaction(async (client) => {
      const userCheck = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
        [userId]
      );
      if (userCheck.rows.length === 0) {
        return {
          deletedUserId: userId,
          deletedWorkspaceIds: [],
          preservedSharedWorkspaceIds: [],
          deletedSessionsCount: 0,
        };
      }

      const wsRes = await client.query<{ workspace_id: string; has_other_members: boolean }>(
        `SELECT m.workspace_id,
                EXISTS (
                  SELECT 1 FROM workspace_memberships m2
                  WHERE m2.workspace_id = m.workspace_id AND m2.user_id <> $1
                ) AS has_other_members
         FROM workspace_memberships m
         WHERE m.user_id = $1`,
        [userId]
      );

      const deletedWorkspaceIds: string[] = [];
      const preservedSharedWorkspaceIds: string[] = [];
      for (const row of wsRes.rows) {
        if (row.has_other_members) {
          preservedSharedWorkspaceIds.push(row.workspace_id);
        } else {
          deletedWorkspaceIds.push(row.workspace_id);
        }
      }

      const sessDel = await client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
      const deletedSessionsCount = Number(sessDel.rowCount || 0);

      await client.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM workspace_memberships WHERE user_id = $1`, [userId]);

      if (deletedWorkspaceIds.length > 0) {
        // Break self-referential parent_sync_run_id FK before cascading workspace deletion
        await client.query(
          `UPDATE shopify_sync_runs SET parent_sync_run_id = NULL WHERE workspace_id = ANY($1::varchar[])`,
          [deletedWorkspaceIds]
        );
        await client.query(`DELETE FROM workspaces WHERE id = ANY($1::varchar[])`, [deletedWorkspaceIds]);
      }

      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);

      return {
        deletedUserId: userId,
        deletedWorkspaceIds,
        preservedSharedWorkspaceIds,
        deletedSessionsCount,
      };
    });
  }

  async getWorkspaceBillingRecipient(workspaceId: string): Promise<WorkspaceBillingRecipient | null> {
    const res = await this.query<WorkspaceBillingRecipient>(
      `SELECT u.id AS "userId", u.email, u.full_name AS "fullName"
       FROM workspace_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1
       ORDER BY CASE WHEN m.role = 'owner' THEN 0 WHEN m.role = 'admin' THEN 1 ELSE 2 END ASC,
                m.created_at ASC
       LIMIT 1`,
      [workspaceId]
    );
    return res.rows[0] || null;
  }

  private mapBillingEmailRow(r: any): BillingEmailDeliveryRecord {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      deliveryKey: r.deliveryKey,
      eventType: r.eventType,
      recipientEmail: r.recipientEmail,
      tier: r.tier ?? null,
      amountCents: r.amountCents !== null && r.amountCents !== undefined ? Number(r.amountCents) : null,
      currency: r.currency ?? null,
      status: r.status,
      smtpMessageAccepted: Boolean(r.smtpMessageAccepted),
      inboxDeliveryConfirmed: Boolean(r.inboxDeliveryConfirmed),
      messageId: r.messageId ?? null,
      errorMessage: r.errorMessage ?? null,
      attemptCount: Number(r.attemptCount || 1),
      nextRetryAt: r.nextRetryAt ? new Date(r.nextRetryAt).toISOString() : null,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload || {},
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
      sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null,
    };
  }

  async createOrClaimBillingEmailDelivery(params: {
    id: string;
    workspaceId: string;
    deliveryKey: string;
    eventType: BillingEmailEventType;
    recipientEmail: string;
    tier?: string | null;
    amountCents?: number | null;
    currency?: string | null;
    payload?: Record<string, unknown>;
    allowRetryFailed?: boolean;
  }): Promise<{ claimed: boolean; record: BillingEmailDeliveryRecord }> {
    return this.withTransaction(async (client) => {
      const existingRes = await client.query<any>(
        `SELECT id, workspace_id AS "workspaceId", delivery_key AS "deliveryKey", event_type AS "eventType",
                recipient_email AS "recipientEmail", tier, amount_cents AS "amountCents", currency,
                status, smtp_message_accepted AS "smtpMessageAccepted",
                inbox_delivery_confirmed AS "inboxDeliveryConfirmed", message_id AS "messageId",
                error_message AS "errorMessage", attempt_count AS "attemptCount",
                next_retry_at AS "nextRetryAt", payload_json AS "payload",
                created_at AS "createdAt", updated_at AS "updatedAt", sent_at AS "sentAt"
         FROM billing_email_deliveries
         WHERE delivery_key = $1
         FOR UPDATE`,
        [params.deliveryKey]
      );

      if (existingRes.rows.length > 0) {
        const existing = this.mapBillingEmailRow(existingRes.rows[0]);
        const stalePending = existing.status === 'pending' && Date.now() - new Date(existing.updatedAt).getTime() > 120_000;
        const retryableFailed = existing.status === 'failed' && Boolean(params.allowRetryFailed);
        if (!stalePending && !retryableFailed) {
          return { claimed: false, record: existing };
        }
        const updRes = await client.query<any>(
          `UPDATE billing_email_deliveries
           SET status = 'pending',
               attempt_count = attempt_count + 1,
               error_message = NULL,
               recipient_email = $2,
               tier = COALESCE($3, tier),
               amount_cents = COALESCE($4, amount_cents),
               currency = COALESCE($5, currency),
               payload_json = COALESCE($6::jsonb, payload_json),
               updated_at = NOW()
           WHERE id = $1
           RETURNING id, workspace_id AS "workspaceId", delivery_key AS "deliveryKey", event_type AS "eventType",
                     recipient_email AS "recipientEmail", tier, amount_cents AS "amountCents", currency,
                     status, smtp_message_accepted AS "smtpMessageAccepted",
                     inbox_delivery_confirmed AS "inboxDeliveryConfirmed", message_id AS "messageId",
                     error_message AS "errorMessage", attempt_count AS "attemptCount",
                     next_retry_at AS "nextRetryAt", payload_json AS "payload",
                     created_at AS "createdAt", updated_at AS "updatedAt", sent_at AS "sentAt"`,
          [
            existing.id,
            params.recipientEmail,
            params.tier ?? null,
            params.amountCents ?? null,
            params.currency ?? null,
            params.payload ? JSON.stringify(params.payload) : null,
          ]
        );
        return { claimed: true, record: this.mapBillingEmailRow(updRes.rows[0]) };
      }

      const insRes = await client.query<any>(
        `INSERT INTO billing_email_deliveries (
           id, workspace_id, delivery_key, event_type, recipient_email, tier, amount_cents, currency,
           status, smtp_message_accepted, inbox_delivery_confirmed, attempt_count, payload_json, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', FALSE, FALSE, 1, $9::jsonb, NOW(), NOW())
         RETURNING id, workspace_id AS "workspaceId", delivery_key AS "deliveryKey", event_type AS "eventType",
                   recipient_email AS "recipientEmail", tier, amount_cents AS "amountCents", currency,
                   status, smtp_message_accepted AS "smtpMessageAccepted",
                   inbox_delivery_confirmed AS "inboxDeliveryConfirmed", message_id AS "messageId",
                   error_message AS "errorMessage", attempt_count AS "attemptCount",
                   next_retry_at AS "nextRetryAt", payload_json AS "payload",
                   created_at AS "createdAt", updated_at AS "updatedAt", sent_at AS "sentAt"`,
        [
          params.id,
          params.workspaceId,
          params.deliveryKey,
          params.eventType,
          params.recipientEmail,
          params.tier ?? null,
          params.amountCents ?? null,
          params.currency ?? null,
          JSON.stringify(params.payload || {}),
        ]
      );
      return { claimed: true, record: this.mapBillingEmailRow(insRes.rows[0]) };
    });
  }

  async updateBillingEmailDeliveryStatus(
    id: string,
    updates: {
      status: BillingEmailDeliveryStatus;
      smtpMessageAccepted?: boolean;
      inboxDeliveryConfirmed?: boolean;
      messageId?: string | null;
      errorMessage?: string | null;
      nextRetryAt?: string | null;
      sentAt?: string | null;
      payload?: Record<string, unknown>;
    }
  ): Promise<BillingEmailDeliveryRecord> {
    const res = await this.query<any>(
      `UPDATE billing_email_deliveries
       SET status = $2,
           smtp_message_accepted = COALESCE($3, smtp_message_accepted),
           inbox_delivery_confirmed = COALESCE($4, inbox_delivery_confirmed),
           message_id = COALESCE($5, message_id),
           error_message = $6,
           next_retry_at = $7::timestamptz,
           sent_at = COALESCE($8::timestamptz, sent_at),
           payload_json = COALESCE($9::jsonb, payload_json),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, workspace_id AS "workspaceId", delivery_key AS "deliveryKey", event_type AS "eventType",
                 recipient_email AS "recipientEmail", tier, amount_cents AS "amountCents", currency,
                 status, smtp_message_accepted AS "smtpMessageAccepted",
                 inbox_delivery_confirmed AS "inboxDeliveryConfirmed", message_id AS "messageId",
                 error_message AS "errorMessage", attempt_count AS "attemptCount",
                 next_retry_at AS "nextRetryAt", payload_json AS "payload",
                 created_at AS "createdAt", updated_at AS "updatedAt", sent_at AS "sentAt"`,
      [
        id,
        updates.status,
        updates.smtpMessageAccepted ?? null,
        updates.inboxDeliveryConfirmed ?? null,
        updates.messageId ?? null,
        updates.errorMessage ?? null,
        updates.nextRetryAt ?? null,
        updates.sentAt ?? null,
        updates.payload ? JSON.stringify(updates.payload) : null,
      ]
    );
    if (res.rows.length === 0) {
      throw new Error(`Billing email delivery ${id} not found`);
    }
    return this.mapBillingEmailRow(res.rows[0]);
  }

  async getBillingEmailDeliveryByKey(deliveryKey: string): Promise<BillingEmailDeliveryRecord | null> {
    const res = await this.query<any>(
      `SELECT id, workspace_id AS "workspaceId", delivery_key AS "deliveryKey", event_type AS "eventType",
              recipient_email AS "recipientEmail", tier, amount_cents AS "amountCents", currency,
              status, smtp_message_accepted AS "smtpMessageAccepted",
              inbox_delivery_confirmed AS "inboxDeliveryConfirmed", message_id AS "messageId",
              error_message AS "errorMessage", attempt_count AS "attemptCount",
              next_retry_at AS "nextRetryAt", payload_json AS "payload",
              created_at AS "createdAt", updated_at AS "updatedAt", sent_at AS "sentAt"
       FROM billing_email_deliveries
       WHERE delivery_key = $1
       LIMIT 1`,
      [deliveryKey]
    );
    return res.rows[0] ? this.mapBillingEmailRow(res.rows[0]) : null;
  }

  async listBillingEmailDeliveries(workspaceId: string, limit = 50): Promise<BillingEmailDeliveryRecord[]> {
    const res = await this.query<any>(
      `SELECT id, workspace_id AS "workspaceId", delivery_key AS "deliveryKey", event_type AS "eventType",
              recipient_email AS "recipientEmail", tier, amount_cents AS "amountCents", currency,
              status, smtp_message_accepted AS "smtpMessageAccepted",
              inbox_delivery_confirmed AS "inboxDeliveryConfirmed", message_id AS "messageId",
              error_message AS "errorMessage", attempt_count AS "attemptCount",
              next_retry_at AS "nextRetryAt", payload_json AS "payload",
              created_at AS "createdAt", updated_at AS "updatedAt", sent_at AS "sentAt"
       FROM billing_email_deliveries
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [workspaceId, limit]
    );
    return res.rows.map((r: any) => this.mapBillingEmailRow(r));
  }

  async listFailedBillingEmailDeliveries(limit = 50): Promise<BillingEmailDeliveryRecord[]> {
    const res = await this.query<any>(
      `SELECT id, workspace_id AS "workspaceId", delivery_key AS "deliveryKey", event_type AS "eventType",
              recipient_email AS "recipientEmail", tier, amount_cents AS "amountCents", currency,
              status, smtp_message_accepted AS "smtpMessageAccepted",
              inbox_delivery_confirmed AS "inboxDeliveryConfirmed", message_id AS "messageId",
              error_message AS "errorMessage", attempt_count AS "attemptCount",
              next_retry_at AS "nextRetryAt", payload_json AS "payload",
              created_at AS "createdAt", updated_at AS "updatedAt", sent_at AS "sentAt"
       FROM billing_email_deliveries
       WHERE status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit]
    );
    return res.rows.map((r: any) => this.mapBillingEmailRow(r));
  }

  private mapShopifyWriteBackRow(r: any): ShopifyWriteBackOperationRecord {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      actionId: r.actionId,
      productId: r.productId,
      shopDomain: r.shopDomain,
      shopifyProductGid: r.shopifyProductGid,
      shopifyVariantGid: r.shopifyVariantGid ?? null,
      fieldPath: r.fieldPath,
      beforeValue: r.beforeValue ?? null,
      approvedValue: r.approvedValue,
      verifiedValue: r.verifiedValue ?? null,
      status: r.status,
      idempotencyKey: r.idempotencyKey,
      shopifyMutationId: r.shopifyMutationId ?? null,
      operatorUserId: r.operatorUserId,
      errorCode: r.errorCode ?? null,
      errorMessage: r.errorMessage ?? null,
      auditMetadata: typeof r.auditMetadata === 'string' ? JSON.parse(r.auditMetadata) : r.auditMetadata || {},
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
      verifiedAt: r.verifiedAt ? new Date(r.verifiedAt).toISOString() : null,
    };
  }

  async createOrClaimShopifyWriteBackOperation(params: {
    id: string;
    workspaceId: string;
    actionId: string;
    productId: string;
    shopDomain: string;
    shopifyProductGid: string;
    shopifyVariantGid?: string | null;
    fieldPath: string;
    beforeValue?: string | null;
    approvedValue: string;
    idempotencyKey: string;
    operatorUserId: string;
    auditMetadata?: Record<string, any>;
  }): Promise<{
    claimed: boolean;
    conflictReason?: string;
    record: ShopifyWriteBackOperationRecord;
  }> {
    return this.withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('aixshop_wb'), hashtext($1))`, [params.workspaceId]);

      const verifiedActionRes = await client.query<any>(
        `SELECT id, workspace_id AS "workspaceId", action_id AS "actionId", product_id AS "productId",
                shop_domain AS "shopDomain", shopify_product_gid AS "shopifyProductGid",
                shopify_variant_gid AS "shopifyVariantGid", field_path AS "fieldPath",
                before_value AS "beforeValue", approved_value AS "approvedValue", verified_value AS "verifiedValue",
                status, idempotency_key AS "idempotencyKey", shopify_mutation_id AS "shopifyMutationId",
                operator_user_id AS "operatorUserId", error_code AS "errorCode", error_message AS "errorMessage",
                audit_metadata_json AS "auditMetadata", created_at AS "createdAt", updated_at AS "updatedAt", verified_at AS "verifiedAt"
         FROM shopify_writeback_operations
         WHERE workspace_id = $1 AND action_id = $2 AND status = 'verified_applied'
         LIMIT 1`,
        [params.workspaceId, params.actionId]
      );
      if (verifiedActionRes.rows.length > 0) {
        return {
          claimed: false,
          conflictReason: 'WRITEBACK_ALREADY_APPLIED',
          record: this.mapShopifyWriteBackRow(verifiedActionRes.rows[0]),
        };
      }

      const keyRes = await client.query<any>(
        `SELECT id, workspace_id AS "workspaceId", action_id AS "actionId", product_id AS "productId",
                shop_domain AS "shopDomain", shopify_product_gid AS "shopifyProductGid",
                shopify_variant_gid AS "shopifyVariantGid", field_path AS "fieldPath",
                before_value AS "beforeValue", approved_value AS "approvedValue", verified_value AS "verifiedValue",
                status, idempotency_key AS "idempotencyKey", shopify_mutation_id AS "shopifyMutationId",
                operator_user_id AS "operatorUserId", error_code AS "errorCode", error_message AS "errorMessage",
                audit_metadata_json AS "auditMetadata", created_at AS "createdAt", updated_at AS "updatedAt", verified_at AS "verifiedAt"
         FROM shopify_writeback_operations
         WHERE workspace_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [params.workspaceId, params.idempotencyKey]
      );
      if (keyRes.rows.length > 0) {
        const existing = this.mapShopifyWriteBackRow(keyRes.rows[0]);
        if (existing.status === 'verified_applied' || existing.status === 'applied_unverified') {
          return { claimed: false, conflictReason: 'WRITEBACK_ALREADY_APPLIED', record: existing };
        }
        if (existing.status === 'pending' && Date.now() - new Date(existing.updatedAt).getTime() < 120_000) {
          return { claimed: false, conflictReason: 'WRITEBACK_IN_PROGRESS', record: existing };
        }
        const updRes = await client.query<any>(
          `UPDATE shopify_writeback_operations
           SET status = 'pending',
               error_code = NULL,
               error_message = NULL,
               operator_user_id = $2,
               audit_metadata_json = $3::jsonb,
               updated_at = NOW()
           WHERE id = $1
           RETURNING id, workspace_id AS "workspaceId", action_id AS "actionId", product_id AS "productId",
                     shop_domain AS "shopDomain", shopify_product_gid AS "shopifyProductGid",
                     shopify_variant_gid AS "shopifyVariantGid", field_path AS "fieldPath",
                     before_value AS "beforeValue", approved_value AS "approvedValue", verified_value AS "verifiedValue",
                     status, idempotency_key AS "idempotencyKey", shopify_mutation_id AS "shopifyMutationId",
                     operator_user_id AS "operatorUserId", error_code AS "errorCode", error_message AS "errorMessage",
                     audit_metadata_json AS "auditMetadata", created_at AS "createdAt", updated_at AS "updatedAt", verified_at AS "verifiedAt"`,
          [existing.id, params.operatorUserId, JSON.stringify(params.auditMetadata || {})]
        );
        return { claimed: true, record: this.mapShopifyWriteBackRow(updRes.rows[0]) };
      }

      const insRes = await client.query<any>(
        `INSERT INTO shopify_writeback_operations (
           id, workspace_id, action_id, product_id, shop_domain, shopify_product_gid, shopify_variant_gid,
           field_path, before_value, approved_value, status, idempotency_key, operator_user_id, audit_metadata_json,
           created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, $13::jsonb, NOW(), NOW())
         RETURNING id, workspace_id AS "workspaceId", action_id AS "actionId", product_id AS "productId",
                   shop_domain AS "shopDomain", shopify_product_gid AS "shopifyProductGid",
                   shopify_variant_gid AS "shopifyVariantGid", field_path AS "fieldPath",
                   before_value AS "beforeValue", approved_value AS "approvedValue", verified_value AS "verifiedValue",
                   status, idempotency_key AS "idempotencyKey", shopify_mutation_id AS "shopifyMutationId",
                   operator_user_id AS "operatorUserId", error_code AS "errorCode", error_message AS "errorMessage",
                   audit_metadata_json AS "auditMetadata", created_at AS "createdAt", updated_at AS "updatedAt", verified_at AS "verifiedAt"`,
        [
          params.id,
          params.workspaceId,
          params.actionId,
          params.productId,
          params.shopDomain,
          params.shopifyProductGid,
          params.shopifyVariantGid ?? null,
          params.fieldPath,
          params.beforeValue ?? null,
          params.approvedValue,
          params.idempotencyKey,
          params.operatorUserId,
          JSON.stringify(params.auditMetadata || {}),
        ]
      );
      return { claimed: true, record: this.mapShopifyWriteBackRow(insRes.rows[0]) };
    });
  }

  async completeShopifyWriteBackOperation(params: {
    operationId: string;
    workspaceId: string;
    actionId: string;
    status: ShopifyWriteBackStatus;
    verifiedValue?: string | null;
    shopifyMutationId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    auditMetadata?: Record<string, any>;
    markActionAppliedExternally?: boolean;
    operatorUserId: string;
    shopDomain: string;
    beforeValue?: string | null;
    approvedValue: string;
    fieldPath: string;
    shopifyProductGid: string;
    shopifyVariantGid?: string | null;
  }): Promise<{
    operation: ShopifyWriteBackOperationRecord;
    action?: ActionItem;
    catalogVersion?: number;
  }> {
    return this.withTransaction(async (client) => {
      const nowIso = new Date().toISOString();
      const opRes = await client.query<any>(
        `UPDATE shopify_writeback_operations
         SET status = $3,
             verified_value = COALESCE($4, verified_value),
             shopify_mutation_id = COALESCE($5, shopify_mutation_id),
             error_code = $6,
             error_message = $7,
             audit_metadata_json = COALESCE(audit_metadata_json, '{}'::jsonb) || $8::jsonb,
             verified_at = CASE WHEN $3 = 'verified_applied' THEN NOW() ELSE verified_at END,
             updated_at = NOW()
         WHERE id = $1 AND workspace_id = $2
         RETURNING id, workspace_id AS "workspaceId", action_id AS "actionId", product_id AS "productId",
                   shop_domain AS "shopDomain", shopify_product_gid AS "shopifyProductGid",
                   shopify_variant_gid AS "shopifyVariantGid", field_path AS "fieldPath",
                   before_value AS "beforeValue", approved_value AS "approvedValue", verified_value AS "verifiedValue",
                   status, idempotency_key AS "idempotencyKey", shopify_mutation_id AS "shopifyMutationId",
                   operator_user_id AS "operatorUserId", error_code AS "errorCode", error_message AS "errorMessage",
                   audit_metadata_json AS "auditMetadata", created_at AS "createdAt", updated_at AS "updatedAt", verified_at AS "verifiedAt"`,
        [
          params.operationId,
          params.workspaceId,
          params.status,
          params.verifiedValue ?? null,
          params.shopifyMutationId ?? null,
          params.errorCode ?? null,
          params.errorMessage ?? null,
          JSON.stringify(params.auditMetadata || {}),
        ]
      );
      if (opRes.rows.length === 0) {
        throw new Error(`Shopify write-back operation ${params.operationId} not found`);
      }

      let updatedAction: ActionItem | undefined;
      let catalogVersion: number | undefined;

      if (params.markActionAppliedExternally && params.status === 'verified_applied') {
        const { storeId, authoritativeStore, catalog } = await this.lockStoreAndLoadCatalogForUpdate(
          client,
          params.workspaceId
        );
        const nextActions = catalog.actions.map((a) => {
          if (a.id !== params.actionId) return a;
          const entry = {
            timestamp: nowIso,
            actor: 'merchant_operator',
            operatorUserId: params.operatorUserId,
            event: 'shopify_writeback_verified',
            operationId: params.operationId,
            shopDomain: params.shopDomain,
            shopifyProductGid: params.shopifyProductGid,
            shopifyVariantGid: params.shopifyVariantGid ?? null,
            fieldPath: params.fieldPath,
            from: params.beforeValue ?? a.proposedChange.from,
            to: params.approvedValue,
            verifiedValue: params.verifiedValue ?? params.approvedValue,
            shopifyMutationId: params.shopifyMutationId ?? null,
          };
          const nextAction: ActionItem = {
            ...a,
            status: 'applied_externally',
            verificationStatus: 'verified_in_catalog',
            auditLog: [...(Array.isArray(a.auditLog) ? a.auditLog : []), entry],
          };
          updatedAction = nextAction;
          return nextAction;
        });

        const nextCatalog: StoragePayloadV1 = {
          ...catalog,
          actions: nextActions,
        };
        catalogVersion = await this.saveCatalogRows(client, params.workspaceId, nextCatalog, storeId, authoritativeStore);
      }

      return {
        operation: this.mapShopifyWriteBackRow(opRes.rows[0]),
        action: updatedAction,
        catalogVersion,
      };
    });
  }

  async listShopifyWriteBackOperations(workspaceId: string, limit = 50): Promise<ShopifyWriteBackOperationRecord[]> {
    const res = await this.query<any>(
      `SELECT id, workspace_id AS "workspaceId", action_id AS "actionId", product_id AS "productId",
              shop_domain AS "shopDomain", shopify_product_gid AS "shopifyProductGid",
              shopify_variant_gid AS "shopifyVariantGid", field_path AS "fieldPath",
              before_value AS "beforeValue", approved_value AS "approvedValue", verified_value AS "verifiedValue",
              status, idempotency_key AS "idempotencyKey", shopify_mutation_id AS "shopifyMutationId",
              operator_user_id AS "operatorUserId", error_code AS "errorCode", error_message AS "errorMessage",
              audit_metadata_json AS "auditMetadata", created_at AS "createdAt", updated_at AS "updatedAt", verified_at AS "verifiedAt"
       FROM shopify_writeback_operations
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [workspaceId, limit]
    );
    return res.rows.map((r: any) => this.mapShopifyWriteBackRow(r));
  }

  async getShopifyWriteBackOperationByKey(
    workspaceId: string,
    idempotencyKey: string
  ): Promise<ShopifyWriteBackOperationRecord | null> {
    const res = await this.query<any>(
      `SELECT id, workspace_id AS "workspaceId", action_id AS "actionId", product_id AS "productId",
              shop_domain AS "shopDomain", shopify_product_gid AS "shopifyProductGid",
              shopify_variant_gid AS "shopifyVariantGid", field_path AS "fieldPath",
              before_value AS "beforeValue", approved_value AS "approvedValue", verified_value AS "verifiedValue",
              status, idempotency_key AS "idempotencyKey", shopify_mutation_id AS "shopifyMutationId",
              operator_user_id AS "operatorUserId", error_code AS "errorCode", error_message AS "errorMessage",
              audit_metadata_json AS "auditMetadata", created_at AS "createdAt", updated_at AS "updatedAt", verified_at AS "verifiedAt"
       FROM shopify_writeback_operations
       WHERE workspace_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [workspaceId, idempotencyKey]
    );
    return res.rows[0] ? this.mapShopifyWriteBackRow(res.rows[0]) : null;
  }
}



