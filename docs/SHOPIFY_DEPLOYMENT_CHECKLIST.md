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
```

---

## 3. Database Schema Verification

Run migrations to ensure tables and composite referential integrity are in place:

```bash
npm run db:migrate
npm run db:status
```

Expected schema elements:
- `shopify_connections`: Stores AES-256-GCM encrypted access and refresh tokens, scopes, and expiration timestamps per `workspace_id`.
- `shopify_sync_runs`: Tracks catalog sync runs, pagination cursors (`cursor_resumed`), discovered/imported counts, and quota enforcement.
- `shopify_webhook_events`: Idempotent delivery tracking with `UNIQUE(shop_domain, topic, event_id)` to deduplicate Shopify deliveries.
- `audit_runs(id, workspace_id)` and `audit_history_snapshots(id, workspace_id, audit_run_id)` composite foreign key integrity.

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
| **Unit & Integration Suite** | 330+ automated tests passing | `npm test` | **PASS** (339 passed, 0 failed) |
| **Composite Snapshot Integrity** | Foreign key on (audit_run_id, workspace_id) | Migration 006 / 008 checks | **PASS** |
| **AES-256-GCM Encryption** | No plaintext tokens stored | `src/server/security/encryption.ts` | **PASS** |
| **Multi-Instance Refresh Lock** | `withShopifyRefreshLock` serialized | `src/server/shopify.test.ts` | **PASS** |
| **Variant Loop Hardening** | Break on repeating cursor & deduplicate | `src/server/shopify/client.ts` | **PASS** |
| **Resumable Sync Workflow** | Resume from `cursorResumed` | `syncService.ts` / API / UI | **PASS** |
| **Live Webhook Verification** | Query Admin GraphQL for subscriptions | `webhookService.ts` / API / UI | **PASS** |
| **Real Shopify Store Live OAuth** | Live Admin GraphQL exchange with Shopify | Live merchant install flow | **BLOCKED — AWAITING CREDENTIALS** (Requires live Shopify store & partner app secrets) |
| **Live PostgreSQL Production DB** | Production Cloud SQL instance | `DATABASE_URL` provisioned | **BLOCKED — AWAITING CREDENTIALS** (Passes via MemoryRepository in dev/test) |
