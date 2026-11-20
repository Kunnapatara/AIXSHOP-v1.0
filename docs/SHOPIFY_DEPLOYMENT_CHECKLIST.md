# AIXSHOP v1.0 — Shopify Production Deployment & Verification Checklist

This runbook defines the authoritative deployment, configuration, and verification procedure for connecting AIXSHOP v1.0 to live Shopify stores using official OAuth 2.0 and Admin GraphQL APIs.

---

## 1. Prerequisites & Shopify Partner Setup

1. **Shopify Partner Account**:
   - Log in to your [Shopify Partner Dashboard](https://partners.shopify.com).
   - Navigate to **Apps** > **Create App** > **Create an app manually**.
   - App Name: `AIXSHOP Catalog & Truth Auditor` (or your preferred branded name).

2. **App Configuration & Credentials**:
   - In Partner Dashboard > App Setup:
     - **Client ID**: Copy into `SHOPIFY_API_KEY`.
     - **Client Secret**: Copy into `SHOPIFY_API_SECRET`.
     - **App URL**: Set to your production domain (e.g. `https://your-domain.run.app`).
     - **Allowed redirection URL(s)**:
       `https://your-domain.run.app/api/shopify/callback`

3. **Access Scopes**:
   - Under **Configuration** > **Admin API integration**:
     - Request access scopes: `read_products` (mandatory).
     - Optional additional scopes for future extensions: `read_inventory`, `read_orders`.
   - Set in environment: `SHOPIFY_SCOPES="read_products"`.

4. **API Version Pinning**:
   - Shopify releases quarterly Admin GraphQL API versions (`YYYY-01`, `YYYY-04`, `YYYY-07`, `YYYY-10`).
   - Pin in environment: `SHOPIFY_API_VERSION="2026-10"`.
   - Never use `unstable` or release candidates in production.

---

## 2. Environment Variables (.env) Reference

Ensure the following variables are configured in production:

```bash
# Server & Environment
NODE_ENV="production"
PORT="3000"
APP_URL="https://your-domain.run.app"
ALLOWED_APP_ORIGINS=""
TRUST_PROXY="1"

# Database (PostgreSQL required in production)
DATABASE_URL="postgresql://user:password@cloudsql-or-pg-host:5432/aixshop_db?sslmode=require"
DATABASE_SSL="true"

# Token Encryption (MANDATORY AES-256-GCM 32-byte hex key)
# Generate via: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SHOPIFY_TOKEN_ENCRYPTION_KEY="<64_character_hex_string>"

# Shopify Partner App Configuration
SHOPIFY_API_KEY="<your_shopify_client_id>"
SHOPIFY_API_SECRET="<your_shopify_client_secret>"
SHOPIFY_APP_URL="https://your-domain.run.app"
SHOPIFY_REDIRECT_URI="https://your-domain.run.app/api/shopify/callback"
SHOPIFY_WEBHOOK_URL="https://your-domain.run.app/api/shopify/webhooks"
SHOPIFY_SCOPES="read_products"
SHOPIFY_API_VERSION="2026-10"

# Billing Configuration (Stripe required in production)
BILLING_PROVIDER="stripe"
STRIPE_SECRET_KEY="sk_live_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_PRICE_STARTER="price_starter_..."
STRIPE_PRICE_GROWTH="price_growth_..."
STRIPE_PRICE_ENTERPRISE="price_enterprise_..."

# Transactional Email / Password Reset SMTP (Optional in dev, required for password reset delivery in production)
PASSWORD_RESET_TOKEN_TTL_MINUTES="30"
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_SECURE="false"
SMTP_STARTTLS="true"
SMTP_USER="<smtp_username>"
SMTP_PASS="<smtp_password>"
SMTP_FROM="AIXSHOP <noreply@your-domain.com>"
SMTP_REJECT_UNAUTHORIZED="true"

# Server-Owned GTIN Exemption Compliance Reviewer Secret (min 32 chars when reviewer API is enabled)
AIXSHOP_PLATFORM_REVIEWER_SECRET="<random_32+_character_secret>"
```

---

## 3. Database Schema Verification

Run migrations to ensure tables and composite referential integrity are in place:

```bash
npm run db:migrate
npm run db:status
# Opt-in audit backfill for pre-012 rows with NULL checksum (only after DBA verification):
npx tsx src/server/db/migrate.ts --backfill-legacy-checksums
```

To run the reproducible live multi-connection PostgreSQL integration tests:
```bash
DATABASE_URL="postgresql://user:pass@localhost:5432/aixshop_test" npm test
```

Expected schema elements:
- `shopify_connections`: Stores AES-256-GCM encrypted access and refresh tokens, scopes, and expiration timestamps per `workspace_id`.
- `shopify_sync_runs`: Tracks catalog sync runs, pagination cursors (`cursor_resumed`), discovered/imported counts, and quota enforcement.
- `shopify_webhook_events`: Idempotent delivery tracking with `UNIQUE(shop_domain, topic, event_id)`, `lease_owner`, `lease_expires_at`, and `attempt_count`.
- `stores`: Includes `catalog_version` for optimistic concurrency + transactional `pg_advisory_xact_lock` catalog mutations.
- `auth_rate_limits`: Shared distributed PostgreSQL auth rate-limit storage.
- `ai_visibility_imports` & `ai_visibility_metrics` & `ai_visibility_observation_history`: Content-hash deduplication, conflict detection, append-only version history, and `topic_presence` (`NULL` vs `''` distinction).
- `schema_migrations`: SHA-256 migration checksum verification (`checksum`, `checksum_verified_at`).
- `audit_runs(id, workspace_id)` and `audit_history_snapshots(id, workspace_id, audit_run_id)` composite foreign key integrity.
- `password_reset_tokens`: Single-use SHA-256 hashed password-recovery tokens with expiration and `consumed_at` timestamps (Migration `014`).
- `workspace_operation_leases`: DB-backed workspace concurrency leases (`shopify_sync`, `demo_migrate`, etc.) enforcing `409 OPERATION_IN_PROGRESS` across multi-instance pods (Migration `014`).
- `evidence_documents`, `evidence_review_audit_log`, & `shopify_product_provenance`: Server-controlled verification defaults (`status = 'pending'`, `verification_source`, `integrity_hash`), immutable review audit history, and synced Shopify `isGiftCard` provenance (Migration `015`).

### Authentication, Commercial Model & SKU Quota Semantics

- **Cookie-Only Session Security**: Browser sessions use `HttpOnly`, `SameSite=Lax` cookies (`aixshop_session`) with `Origin`/`Referer` + `X-Requested-With` CSRF enforcement and automatic session rotation on `/login`, `/register`, and `/switch-workspace`.
- **Commercial Plan Boundaries**:
  - `Free Audit` ($0, `billingInterval: 'none'`): Non-recurring free workspace onboarding tier covering up to `2,500` SKUs (does not create recurring subscriptions, checkout sessions, or invoices; returns redacted catalog state and blocks audit runs, findings, severity counts, evidence trails, remediation mutations, historical inspection, AI discovery audits, and feed validation/exports with `403 REPORT_PAYMENT_REQUIRED` until an eligible paid subscription is verified).
  - `Starter` ($49/mo / 250 verified SKUs), `Growth` ($149/mo / 2,500 verified SKUs), `Enterprise` ($499/mo / Unlimited verified SKUs): Unlock full reporting and remediation strictly upon verified `active` or `trialing` subscription status.

---

## 4. Multi-Instance Concurrency & Token Refresh

AIXSHOP v1.0 implements a multi-instance distributed refresh lock:
- When running in a multi-pod or serverless environment (e.g. Cloud Run, Kubernetes), token refresh operations are serialized via `SELECT ... FOR UPDATE` on `shopify_connections` inside an atomic transaction.
- When worker A obtains the lock, it refreshes the token and rotates the refresh token.
- When worker B acquires the lock immediately afterward, it re-evaluates `token_expires_at` under the lock and skips calling the Shopify token endpoint, preventing single-use refresh token revocation and race conditions.

---

## 5. Catalog Synchronization & Resumability Runbook

1. **Full Catalog Synchronization**:
   - In Settings > Connectors > Shopify: Click **"Sync Full Catalog"**.
   - Admin GraphQL queries `products(first: 50)` with variant pagination (>100 variants per product handled safely).
   - If plan SKU limits are exceeded, import terminates honestly and flags `excludedByPlan` without silently corrupting data.

2. **Resumable Sync Execution**:
   - If a large sync hits pagination ceilings or is interrupted, the sync run is saved with status `partially_completed` and records `cursor_resumed`.
   - The UI displays an alert banner with the stored cursor.
   - Click **"Resume Sync"** (or invoke `POST /api/shopify/sync/resume`).
   - The sync picks up from `cursor_resumed` and seamlessly appends remaining products into the catalog without duplicating existing products.

---

## 6. Webhook Setup & Live Verification

AIXSHOP registers four mandatory webhook subscriptions via Admin GraphQL:
1. `PRODUCTS_CREATE`
2. `PRODUCTS_UPDATE`
3. `PRODUCTS_DELETE`
4. `APP_UNINSTALLED`

### Webhook Verification Workflow:
1. In Settings > Connectors > Shopify:
   - Click **"Register Webhooks"** (`POST /api/shopify/webhooks/register`) to register subscriptions.
   - Click **"Verify Live"** (`POST /api/shopify/webhooks/verify`) to query Shopify Admin GraphQL `webhookSubscriptions(first: 25)`.
2. Truth Boundary States:
   - **Active (`verified: true`)**: All 4 required topics are confirmed active on Shopify Admin API.
   - **Partially Registered**: Some topics are missing (e.g., if deleted in Partner Dashboard).
   - **Registered Unverified**: Webhook mutations succeeded locally, but live Admin query has not confirmed them.
   - **Not Configured / Inactive**: Shopify is disconnected or subscriptions were not registered.
3. Out-of-Order Delivery Protection:
   - Webhook payloads include `updated_at`. If an older webhook delivery arrives after a newer update has already been applied, AIXSHOP discards the stale delivery and logs an informational warning.

---

## 7. Verification Truth Boundary & Test Gate

| Check / Gate | Target | Verification Method | Status |
|:---|:---|:---|:---|
| **TypeScript Build** | Zero type errors | `npm run lint` / `tsc --noEmit` | **PASS** |
| **Vite Bundle Build** | Zero bundling errors | `npm run build` | **PASS** |
| **Unit & Integration Suite** | All unit & integration tests passing | `npm test` | **PASS** (556 passed, 0 failed, 4 external Postgres skipped) |
| **Composite Snapshot Integrity** | Foreign key on (audit_run_id, workspace_id) | Migration 006 / 008 checks | **PASS** |
| **AES-256-GCM Encryption** | No plaintext tokens stored | `src/server/security/encryption.ts` | **PASS** |
| **Multi-Instance Refresh Lock** | Transaction-scoped `saveConnection` inside `withShopifyRefreshLock` | `oauthService.ts` / `postgresRepository.ts` / `shopify.test.ts` | **PASS** |
| **Variant Loop Hardening** | Explicit `VariantCompletenessStatus` & `partially_completed` enforcement | `client.ts` / `syncService.ts` / `workstreams.test.ts` | **PASS** |
| **Durable Sync Run Lineage** | Workspace-scoped `resumeShopifySync`, `parentSyncRunId`, `attemptNumber` | Migration 009 / `syncService.ts` / `SettingsPage.tsx` | **PASS** |
| **Live Webhook Verification** | GraphQL pagination + callback URL matching (`active`, `mismatch`, `partially_registered`) | `webhookService.ts` / `shopify.test.ts` / `workstreams.test.ts` | **PASS** |
| **AI Discovery & Business Hub** | 8-dimension deterministic scoring, Business Profile CRUD, Hub Checklist | `discoveryEngine.ts` / `discoveryRoutes.ts` / `businessProfileRoutes.ts` | **PASS** |
| **Feed Readiness & Safe Audit** | GMC, Meta, Schema.org validators, CSV/JSON export, `needsMerchantInput` safety | `feedValidationEngine.ts` / `auditEngine.ts` / `workstreams.test.ts` | **PASS** |
| **AI Visibility Monitoring** | `DATA_SOURCE_NOT_CONNECTED` empty state & CSV ingestion deduplication | `visibilityRoutes.ts` / `AiVisibilityPage.tsx` / `workstreams.test.ts` | **PASS** |
| **Billing & Stale Event Recovery** | Stripe webhook idempotency & >5m `processing` lock reclaim | `billingService.ts` / `postgresRepository.ts` / `workstreams.test.ts` | **PASS** |
| **Real Shopify Store Live OAuth** | Live Admin GraphQL exchange with Shopify | Live merchant install flow | **BLOCKED — AWAITING CREDENTIALS** (Requires live Shopify store & partner app secrets) |
| **Live PostgreSQL Production DB** | Production Cloud SQL instance (Migrations 001–015) | `DATABASE_URL` provisioned | **BLOCKED — AWAITING CREDENTIALS** (Passes via MemoryRepository & Postgres mock suite in dev/test) |

---

## 8. Staging Deployment, Operations & Rollback Runbook

### Pre-Deployment Preflight Gate
1. Run `npm run config:check -- --strict` in the target Staging/Production environment to verify without logging secret values that `DATABASE_URL`, `APP_URL`, `SHOPIFY_TOKEN_ENCRYPTION_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SHOPIFY_*` URLs, `TRUST_PROXY`, and `AUTH_RATE_LIMIT_FAILURE_MODE` are valid.
2. Execute forward-only PostgreSQL migrations (`001..015`) before shifting traffic:
   ```bash
   npm run db:migrate
   npm run db:status
   ```
3. Build client bundle (`npm run build`) and start the server (`npm start`, Express on `PORT=3000`).

### Reverse Proxy, TLS, Cookie & CORS Rules
- **HTTPS Termination & Proxy**: Set `TRUST_PROXY="1"` behind Cloud Run / managed load balancers (never bare `"true"` in production). All public traffic (`APP_URL`, `SHOPIFY_APP_URL`, `ALLOWED_APP_ORIGINS`) must terminate TLS (`https://`).
- **Session Cookies**: `aixshop_session` is issued `HttpOnly`, `SameSite=Lax`, and `Secure` (`NODE_ENV=production`). Browser API clients remain cookie-only without `Authorization: Bearer` tokens or hardcoded credentials.
- **CSRF & Origin Validation**: State-changing endpoints enforce `Origin` / `Referer` matching trusted origins (`APP_URL` + `ALLOWED_APP_ORIGINS`) plus `X-Requested-With: XMLHttpRequest`, except webhook ingress routes (`/api/billing/webhook`, `/api/shopify/webhooks`) which require cryptographic HMAC signatures over raw request bytes.
- **Referrer Privacy**: All server responses include `Referrer-Policy: no-referrer` so password-reset URL fragments (`/#reset_token=...`) never leak via outbound links.

### Health & Readiness Probes
- **Liveness**: `GET /api/health/live` -> `200 OK` (Node event loop responsive).
- **Readiness**: `GET /api/health/ready` -> `200 OK` only when PostgreSQL connectivity passes, migrations `001..015` schema checks pass, and `validateProductionConfig().valid` is `true` in production (`503` otherwise).

### Safe Rollback Procedure
1. Migrations `001..015` are strictly **forward-only** (additive columns/tables and constraint hardening). Never drop tables, delete `schema_migrations` entries, or reset databases on rollback.
2. To roll back an application release cleanly:
   - Shift load balancer / Cloud Run revision traffic back to the prior known-good container digest while preserving the forward-migrated database schema.
   - Do **not** replay modified SQL migration files; `npm run db:status` verifies SHA-256 checksums and fails closed on drift.
   - If webhook deliveries backed up during an incident, inspect and replay retryable events cleanly using `npm run billing:recover`.

