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
