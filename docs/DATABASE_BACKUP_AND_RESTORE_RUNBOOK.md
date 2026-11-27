# AIXSHOP v1.0 — Database Backup & Restore Runbook

> **Scope & Safety Boundary:** This runbook defines AIXSHOP's PostgreSQL backup strategy, retention targets, RPO/RTO objectives, and non-destructive **Scratch Database** restore verification procedure. Never execute restore drills against a live production database or delete existing migration ledgers.

---

## 1. Managed PostgreSQL Capabilities & Provider Matrix

AIXSHOP v1.0 uses forward-only PostgreSQL migrations (`001` through `019`) tracked in `schema_migrations` with SHA-256 integrity checksums. For commercial deployment, use a managed PostgreSQL provider with native automated snapshots and Write-Ahead Log (WAL) Point-in-Time Recovery (PITR):

| Managed Provider | Automated Daily Backups | Continuous WAL Archiving (PITR) | Clone / Restore Target Model |
|:---|:---|:---|:---|
| **Google Cloud SQL (PostgreSQL)** | Built-in automated daily backup window | Built-in PITR (1–7+ days transaction log retention) | Point-in-time clone to a **new isolated instance** |
| **AWS RDS / Aurora PostgreSQL** | Automated daily snapshots (up to 35 days) | Continuous S3 transaction logs (`LatestRestorableTime`) | Restore to a **new DB instance** (never in-place overwrite) |
| **Supabase / Neon PostgreSQL** | Managed daily physical backups | Branching / PITR log replay (plan-dependent) | Restore into an **isolated branch / new project** |

> **Design Principle:** AIXSHOP relies on **native Managed PostgreSQL Automated Backups + PITR** rather than running redundant custom cron backup daemons inside application containers. Supplementary logical `pg_dump` exports (`scripts/ops/backup-postgres.sh`) are intended only for pre-release change checkpoints and isolated scratch restore drills.

---

## 2. Retention Policy & RPO / RTO Targets

| Metric | Target | Operational Mechanism |
|:---|:---|:---|
| **Daily Automated Snapshots** | **30 days retention** (minimum 14 days for staging) | Managed PostgreSQL snapshot policy, encrypted at rest |
| **WAL / PITR Window** | **7–14 days continuous WAL retention** | Continuous transaction log archiving enabled before launch |
| **Recovery Point Objective (RPO)** | **≤ 5 minutes** (with PITR enabled) / ≤ 24h snapshot fallback | Continuous WAL archiving + transactional outbox/webhook ledgers |
| **Recovery Time Objective (RTO)** | **≤ 45 minutes** (Tier-1 database restore + readiness verification) | Provision new managed clone/instance + `npm run db:status` + cutover |
| **Pre-Migration Logical Snapshot** | Retained 7 days offline encrypted | `scripts/ops/backup-postgres.sh` before major schema upgrades |

---

## 3. Critical Tables Covered

Restore verification must confirm presence and row-readiness of all AIXSHOP core tenant, security, billing, and sync tables:
- `users`, `workspaces`, `workspace_memberships`, `sessions`, `password_reset_tokens`
- `stores`, `workspace_operation_leases`, `auth_rate_limits`
- `shopify_connections`, `shopify_sync_runs`, `shopify_webhook_events`, `shopify_product_provenance`, `shopify_writeback_operations`
- `subscriptions`, `billing_events`, `billing_email_deliveries`
- `audit_runs`, `audit_history_snapshots`, `evidence_documents`, `evidence_review_audit_log`
- `ai_visibility_imports`, `ai_visibility_metrics`, `ai_visibility_observation_history`
- `schema_migrations` (`001_initial_schema.sql` through `019_writeback_and_billing_emails.sql`)

---

## 4. Non-Production Logical Backup & Scratch Restore Drill

### A. Create a Logical Backup (Read-Only Source Dump)

```bash
DATABASE_URL="postgresql://reader:***@source-host:5432/aixshop_staging?sslmode=require" \
  ./scripts/ops/backup-postgres.sh ./tmp_backups
```

- Uses `pg_dump --format=custom --no-owner --no-privileges` (non-blocking MVCC snapshot).
- Produces a timestamped `.dump` file plus `.sha256` checksum without printing credentials.

### B. Verify Restore Against an Isolated **Scratch Database ONLY**

```bash
CONFIRM_SCRATCH_RESTORE="true" \
SCRATCH_DATABASE_URL="postgresql://user:***@localhost:5432/aixshop_scratch_restore" \
  ./scripts/ops/restore-verify-postgres.sh ./tmp_backups/aixshop_backup_YYYYMMDD_HHMMSS.dump
```

Safety guards built into `restore-verify-postgres.sh`:
1. Refuses to run unless `CONFIRM_SCRATCH_RESTORE="true"`.
2. Refuses if `NODE_ENV="production"`.
3. Refuses if `SCRATCH_DATABASE_URL` matches `DATABASE_URL` or contains production identifiers (`prod`, `live`, `primary`) instead of explicit scratch/test markers (`scratch`, `restore_verify`, `drill`, `test`, or `localhost`/`127.0.0.1` scratch DB).
4. Verifies `.sha256` checksum (if present) before restoring.
5. Runs `pg_restore` into the isolated scratch DB and executes read-only verification queries checking `schema_migrations` count (`>= 19`, including `019_writeback_and_billing_emails.sql`), core table existence (`workspaces`, `stores`, `subscriptions`, `billing_email_deliveries`, `shopify_connections`), and row counts.

---

## 5. Production Cutover / Emergency Restore Runbook

1. **Freeze Writes (if source is partially degraded):** Scale application workers down or place ingress in maintenance mode so billing/webhook retries do not diverge across instances.
2. **Provision Isolated Recovery Instance:** Use the Managed PostgreSQL console/CLI to restore a **new instance** from the target PITR timestamp (or latest healthy snapshot) — **never overwrite the failed primary in-place before capturing forensic logs**.
3. **Verify Schema & Integrity Before Cutover:**
   ```bash
   DATABASE_URL="<new-restored-instance-url>" npm run db:status
   ```
   Confirm `001`–`019` checksums report valid and inspect recent rows in `billing_events`, `billing_email_deliveries`, and `shopify_sync_runs`.
4. **Update Connection Secret & Validate:** Point staging/canary or production `DATABASE_URL` secret to the verified restored instance, restart the server, and verify:
   - `GET /api/health/ready` returns `HTTP 200`
   - `npm run billing:recover` sweeps any pending webhook leases safely
   - `npm run billing:retry-emails` resumes any queued `'failed'` lifecycle emails
5. **Decommission Old Instance:** Retain the prior instance read-only for 48–72 hours for incident review before deletion.

---

## 6. Current Environment Verification Status

| Check | Status | Notes |
|:---|:---|:---|
| Managed PostgreSQL Capabilities & Retention/RPO/RTO Runbook | **DOCUMENTED** | `docs/DATABASE_BACKUP_AND_RESTORE_RUNBOOK.md` |
| Safe Backup & Scratch-Only Restore Verification Scripts | **IMPLEMENTED (SYNTAX CHECKED)** | `scripts/ops/backup-postgres.sh`, `scripts/ops/restore-verify-postgres.sh` |
| Live PostgreSQL Scratch Backup & Restore Execution Drill | **BLOCKED — AWAITING POSTGRESQL INSTANCE & `pg_dump`/`psql` TOOLS** | Workspace container has no `DATABASE_URL` or PostgreSQL client binaries (`pg_dump`/`psql`). |
