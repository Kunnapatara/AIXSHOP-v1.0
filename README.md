# AIXSHOP v1.0 — Production Deployment & Database Operations Guide

AI Commerce Visibility & Product Catalog Intelligence platform for multi-channel merchant catalogs.

---

## 1. Database Configuration & Precedence

AIXSHOP connects to PostgreSQL with clear configuration precedence:

1. **`DATABASE_URL`** (Primary): Full connection URI, e.g., `postgresql://user:password@host:5432/dbname`
2. **`SQL_*` Variables** (Secondary):
   - `SQL_HOST`: Database server hostname
   - `SQL_PORT`: Port (default: 5432)
   - `SQL_USER`: Username
   - `SQL_PASSWORD`: Password
   - `SQL_DB_NAME`: Database name
3. **`PG*` Variables** (Fallback):
   - `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`

### Environment Safety Rules
- **Production (`NODE_ENV=production`)**: Durable PostgreSQL configuration is strictly required. If credentials or connectivity are missing, startup halts immediately with an explicit error to prevent customer data loss. Silent fallback to memory storage is forbidden.
- **Development/Test (`NODE_ENV !== 'production'`)**: If PostgreSQL is unconfigured, the server safely initializes an in-memory repository (`MemoryRepository`) with full multi-tenant isolation for local evaluation.

### SSL / TLS Configuration
- Enforce TLS certificate verification by default: `DATABASE_SSL=true`.
- To specify CA root certificate: set `PGSSLROOTCERT=/path/to/server-ca.pem` or `SQL_CA_CERT="..."`.
- `DATABASE_SSL_REJECT_UNAUTHORIZED="false"` should only be used in internal test environments with self-signed certificates; disabling verification in production emits an explicit security warning.

---

## 2. Database Migrations

AIXSHOP migrations are managed by the idempotent migration runner in `src/server/db/migrate.ts`.

### Commands
- **Run migrations**:
  ```bash
  npm run db:migrate
  ```
- **Inspect migration status (read-only)**:
  ```bash
  npm run db:status
  ```

### Migration Safety & Integrity
1. **Advisory Lock**: Acquires a PostgreSQL session-level advisory lock (`pg_advisory_lock`) using documented constant keys (`1095325779`, `1296656210`) to serialize concurrent deployment processes and prevent race conditions.
2. **Transaction Isolation**: Each migration file executes inside an isolated transaction (`BEGIN ... COMMIT`). If any statement fails, the transaction is rolled back (`ROLLBACK`) and the migration record is not written.
3. **Version Tracking**: Successful migrations are recorded in the `schema_migrations` table with `id` and `applied_at`.
4. **Idempotency**: Running `npm run db:migrate` multiple times is safe and skips previously applied migrations.

---

## 3. Health & Readiness Probes

Designed for Kubernetes, Cloud Run, and container orchestrators:

| Probe Endpoint | Purpose | Success (HTTP 200) | Failure (HTTP 503) |
| :--- | :--- | :--- | :--- |
| **`GET /api/health/live`** | Liveness Probe | Node.js process and event loop are responsive. Does not fail during temporary DB blips. | Process unresponsive / hanging |
| **`GET /api/health/ready`** | Readiness Probe | PostgreSQL connection is active AND database schema + migrations are verified ready. | Database disconnected or schema/migrations pending |
| **`GET /api/health`** | General Health | Checks readiness by default; returns 200 when ready, 503 if dependencies fail. Supports `?probe=live`. | Database disconnected or schema/migrations pending |

---

## 4. Post-Deployment Verification Checklist

1. **Verify Database Status**:
   ```bash
   npm run db:status
   ```
   Should output: `[AIXSHOP Migration Status] Schema is fully up to date.` with exit code `0`.
2. **Verify Server Liveness**:
   ```bash
   curl -f http://localhost:3000/api/health/live
   ```
3. **Verify Server Readiness**:
   ```bash
   curl -f http://localhost:3000/api/health/ready
   ```
4. **Verify Catalog API**:
   Authenticate a user and call `GET /api/catalog` with an authorization cookie or header.

---

## 5. Troubleshooting & Diagnostics

- **Startup fails with `[AIXSHOP Fatal Startup Error]`**:
  Ensure `DATABASE_URL` or `SQL_HOST` / `SQL_DB_NAME` / `SQL_USER` are configured in your production environment variables.
- **Readiness probe returns `503 Unavailable` with `reason: Database schema incomplete or migrations pending`**:
  Run `npm run db:migrate` to apply the required schema (`001_initial_schema.sql`).
- **Readiness probe returns `503 Unavailable` with `reason: Database connection unreachable`**:
  Verify network firewalls, PostgreSQL port, and credentials.

---

## 6. Billing Webhook Recovery & Operations (Migration 013)

AIXSHOP persists verified Stripe/billing webhook events in `billing_events` with durable lease ownership (`lease_owner`, `lease_expires_at`), retry tracking (`attempt_count`, `next_retry_at`), and sanitized `last_error` diagnostics without overwriting `payload_json`.

### Scheduler Status (`BILLING_RECOVERY_ENABLED`)
- **Disabled by default**: `BILLING_RECOVERY_ENABLED` is **not enabled automatically**. Unless explicitly set to `"true"` in a running non-test `server.ts` process, no background recovery interval runs inside the web server.
- **External Scheduler Recommended in Production**: In multi-instance, auto-scaling, or scale-to-zero environments (such as Cloud Run), configure an **external scheduler** (e.g., Cloud Scheduler + job runner or Kubernetes CronJob) to execute the one-shot CLI sweep periodically instead of relying on an in-process timer.

### Running Recovery & Manual Replay (`npm run billing:recover`)
- **Run a bounded automated recovery sweep** (finalizes expired `processing` leases at `maxAttempts` to `permanently_failed`, and retries eligible `failed` or expired `processing` events below `maxAttempts`):
  ```bash
  npm run billing:recover -- --limit=50 --max-attempts=5
  ```
- **Safely reprocess a specific dead-lettered event** (only after fixing the underlying workspace/catalog issue; refuses already-`processed` or `ignored` events and preserves active processing leases):
  ```bash
  npm run billing:recover -- --event-id=evt_1234567890
  ```

### Inspecting Failed Events & Expired Processing Leases
- **Inspect dead-lettered (`permanently_failed`) events**:
  ```sql
  SELECT event_id, provider, event_type, attempt_count, last_error, last_attempt_at, updated_at
  FROM billing_events
  WHERE status = 'permanently_failed'
  ORDER BY updated_at DESC
  LIMIT 50;
  ```
- **Identify expired `processing` leases** (candidates for recovery or final-attempt finalization):
  ```sql
  SELECT event_id, provider, event_type, attempt_count, lease_owner, lease_expires_at, processed_at
  FROM billing_events
  WHERE status = 'processing'
    AND (
      (lease_expires_at IS NOT NULL AND lease_expires_at < clock_timestamp())
      OR (lease_expires_at IS NULL AND processed_at < clock_timestamp() - INTERVAL '5 minutes')
    )
  ORDER BY COALESCE(lease_expires_at, processed_at) ASC;
  ```

### Detecting Failure-State Persistence Errors
- Monitor structured error logs for **`[AIXSHOP Billing Error Persistence]`**.
- Logged fields include `eventId`, `currentStatus`, `targetStatus`, `attemptCount`, `classification`, `operation`, `leaseOwner`, `failureStatePersisted: false`, `leaseLost`, redacted `persistenceError`, and redacted `originalError` (raw payloads, secrets, and payment data are never logged).
- If persistence fails, the event is **never** falsely reported as `permanently_failed` and remains recoverable once its processing lease expires.

---

## 7. PostgreSQL CI Configuration & External Integration Status

### Safe PostgreSQL CI Credentials
- Configure `DATABASE_URL` explicitly with user credentials (e.g. `postgresql://aixshop:<ci_password>@localhost:5432/aixshop_test`) in CI workflow `env` so `getPostgresPoolConfig()` connects via `connectionString` and never falls back to a host OS role such as `root`.
- Ensure test suites that temporarily override `process.env.DATABASE_URL` snapshot and restore the original value in `finally` blocks before live PostgreSQL pool creation.

### External Integration Verification Truth Boundary
- **Stripe Test Mode (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`)**: `BLOCKED — TEST CREDENTIALS / CONFIGURATION UNAVAILABLE` (not executed against live Stripe APIs in this environment).
- **Shopify Development Store (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`)**: `BLOCKED — SHOPIFY DEVELOPMENT STORE ACCESS UNAVAILABLE`. Current connector scope is read-only (`read_products`, `writeBackAuthorized: false`).
- **Complete End-to-End Customer Journey**: `BLOCKED` pending live Stripe Test Mode and Shopify Development Store credentials.

---

## 8. Commercial Integration Verification Infrastructure

See [`docs/COMMERCIAL_VERIFICATION_GUIDE.md`](docs/COMMERCIAL_VERIFICATION_GUIDE.md), [`docs/COMMERCIAL_VERIFICATION_EVIDENCE_TEMPLATE.md`](docs/COMMERCIAL_VERIFICATION_EVIDENCE_TEMPLATE.md), and [`docs/COMMERCIAL_VERIFICATION_REPORT.md`](docs/COMMERCIAL_VERIFICATION_REPORT.md).

- **Unit tests:** `npm run test:unit`
- **Integration contract & local loopback tests (CI-safe):** `npm run test:contracts`
- **PostgreSQL integration tests (requires `DATABASE_URL` or `SQL_HOST`):** `npm run test:postgres`
- **Secret-safe commercial readiness check:** `npm run verify:config`
- **External stage runners (require `COMMERCIAL_VERIFY_EXTERNAL=true` + real credentials; otherwise report `BLOCKED`):**
  - `npm run verify:shopify` (Stage 1 — Shopify Development Store)
  - `npm run verify:stripe` (Stage 2 — Stripe Test Mode, rejects `sk_live_`)
  - `npm run verify:smtp` (Stage 3 — Real SMTP Provider)
  - `npm run verify:staging-e2e` (Stage 4 — Staging End-to-End Customer Journey)
  - `npm run verify:commercial:report -- --write` (Generate aggregate Markdown report)

