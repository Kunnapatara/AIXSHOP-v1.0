# AIXSHOP v1.0 — Pre-ENV Release Freeze Report

- **Generated At:** 2026-11-26T08:35:00Z
- **Repository Baseline:** `Kunnapatara/AIXSHOP-v1.0`
- **Freeze Mode:** Pre-ENV Engineering Freeze (strictly zero real external credentials or `.env` configuration)
- **Overall Pre-ENV Status:** **READY FOR EXTERNAL ENV & STAGING VERIFICATION** (`PASS` / `PASS — SIMULATED` locally; `ALL_EXTERNAL_BLOCKED` for live external providers)

---

## A. Executive Freeze Summary

All outstanding Pre-ENV engineering tasks (**Tasks A–F**), environment variable documentation parity, migration integrity checks, static security checks, TypeScript compilation, production bundling, and full local regression suites have been completed and verified without adding any real API keys, tokens, passwords, or `.env` files.

### Verified Build, Lint & Test Metrics (Post-Final-Edit)

| Check / Command | Result | Exact Observed Outcome | Classification |
| --- | --- | --- | --- |
| `npm run lint` (`tsc --noEmit`) | **PASS** | 0 TypeScript errors | `PASS` |
| `npm run build` (`vite build`) | **PASS** | Production client bundle compiled cleanly | `PASS` |
| `npm run config:check` | **PASS** | `valid: true`, `environment: "development"`, `missingOrInvalid: []` | `PASS` |
| `npm run verify:config` | **BLOCKED** | `Overall Readiness Summary: ALL_EXTERNAL_BLOCKED` (expected without ENV) | `BLOCKED` |
| `npm test` (`tsx --test "src/**/*.test.ts"`) | **PASS** | **634 tests / 137 suites: 627 passed, 0 failed, 0 cancelled, 7 skipped** | `PASS` / `PASS — SIMULATED` |
| `npm run test:unit` | **PASS** | **164 tests / 37 suites: 164 passed, 0 failed** | `PASS` |
| `npm run test:contracts` | **PASS** | **20 tests / 8 suites: 20 passed, 0 failed** | `PASS — SIMULATED` |
| `npm run test:postgres` | **PASS** | **48 tests / 6 suites: 43 passed, 0 failed, 5 skipped** (live PG skipped) | `PASS` / `BLOCKED` (live PG) |
| `npm run db:status` | **BLOCKED** | Exits cleanly with error: PostgreSQL (`DATABASE_URL`/`SQL_HOST`/`PGHOST`) not configured | `BLOCKED` |
| Static security grep (`ci.yml` parity) | **PASS** | `CI_STATIC_SECURITY_PASS`: zero `sk_live_`/`whsec_` literals in `src/`, cookie-only `src/api/client.ts` | `PASS` |

> **Skipped Tests Explanation (7 tests in `npm test`):** All 7 skipped tests are live PostgreSQL 16 integration cases across `src/server/gtinEvidenceTrust.test.ts`, `src/server/postgresEntitlements.test.ts`, `src/server/productionBlockers.test.ts`, `src/server/db/migrate.test.ts`, `src/server/shopifyAtomicProvenance.test.ts`, and `src/server/shopifyWebhookStatusPostgres.test.ts` that require `DATABASE_URL`, `SQL_HOST`, or `PGHOST` to be provisioned.

---

## B. Completed Pre-ENV Tasks (A–F)

### Task A — Deterministic Staging E2E Cleanup
- **Implementation:** `src/server/verification/stagingE2EVerifier.ts` tracks every test user (`userId`, `email`), workspace (`workspaceId`), session cookie, and checkout session created during Stage 4 execution and performs deterministic teardown via `DELETE /api/auth/account` inside `finally`, followed by post-delete verification (`401` on stale session cookies) and `CleanupReport` emission.
- **Verification:** `src/server/verification/stagingE2EVerifier.test.ts` (`PASS — SIMULATED` against local test server).

### Task B — Strict Cross-Tenant Isolation & Negative Verification
- **Implementation:** `S4-TENANT-ISOLATION-STRICT` in `src/server/verification/stagingE2EVerifier.ts` verifies that User B attempting header tampering (`x-workspace-id: <workspaceA>`) or workspace switching into Workspace A is denied (`403`) and cannot read seeded Tenant A catalog, store profile, billing, Shopify, audit, or action resources.
- **Verification:** `src/server/verification/stagingE2EVerifier.test.ts` includes negative false-positive tests confirming isolation checks fail if any Tenant A marker leaks (`PASS — SIMULATED`).

### Task C — Merchant-Approved Shopify Write-Back Capability
- **Implementation:**
  - Server scope gate, allowlisted field parser (`title`, `variants[i].barcode`, `variants[i].sku`, `variants[i].price`), workspace operation lease, idempotency ledger (`shopify_writeback_operations`), Shopify Admin GraphQL (`2026-10`) mutation, and post-mutation read-back verification (`src/server/shopify/writeBackService.ts`, `src/server/shopify/client.ts`, `src/server/shopify/oauthService.ts`, `src/server/shopify/types.ts`, `src/server/app.ts`).
  - Default OAuth scope remains read-only (`read_products`), with explicit opt-in consent for `write_products` and dedicated UI controls (`src/pages/ActionsPage.tsx`, `src/pages/SettingsPage.tsx`).
  - Durable additive schema in `src/server/db/migrations/019_writeback_and_billing_emails.sql`.
- **Verification:** `src/server/shopifyWriteBack.test.ts` (`PASS — SIMULATED`).

### Task D — Checkout Confirmation & Billing Lifecycle Emails
- **Implementation:**
  - Idempotent, secret-safe transactional billing emails across 5 lifecycle event types: Checkout/Payment Confirmed (`initial_payment_confirmed`), Subscription Renewed (`invoice.payment_succeeded` / `invoice.paid`), Plan Updated (`customer.subscription.updated`), Payment Action Required (`invoice.payment_failed`), and Subscription Canceled (`customer.subscription.deleted`, `cancel_at_period_end`, or full `charge.refunded`) in `src/server/services/billingService.ts` and `src/server/services/emailService.ts`.
  - Durable delivery ledger (`billing_email_deliveries`), explicitly invoked retry helper (`retryFailedBillingEmails` — not scheduled by a background timer in `server.ts`), and workspace-isolated read endpoint (`GET /api/billing/email-deliveries`) backed by Migration `019`.
- **Verification:** `src/server/billingEmail.test.ts` (`PASS — SIMULATED`); `docs/COMMERCIAL_VERIFICATION_GUIDE.md` updated to document `invoice.paid` as supported, `customer.discount.created` as the unhandled example, and the full Email Event Matrix.

### Task E — 30-Step Customer Journey E2E & Commercial Verification Reports
- **Implementation:**
  - Full 30-step local HTTP + Sandbox billing + mocked Shopify Admin GraphQL + loopback `node:net` SMTP customer journey suite in `src/server/customerJourney30Step.e2e.test.ts`.
  - Automated CLI runners (`scripts/verify/run-shopify.ts`, `run-stripe.ts`, `run-smtp.ts`, `run-staging-e2e.ts`, `generate-report.ts`) and verification guides (`docs/COMMERCIAL_VERIFICATION_GUIDE.md`, `docs/COMMERCIAL_VERIFICATION_REPORT.md`, `docs/COMMERCIAL_VERIFICATION_EVIDENCE_TEMPLATE.md`, `docs/MANUAL_EXTERNAL_VERIFICATION_CHECKLIST.md`).
- **Verification:** `src/server/customerJourney30Step.e2e.test.ts` + `src/server/customerJourney.e2e.test.ts` + `src/server/verification/stagingE2EVerifier.test.ts` (`PASS — SIMULATED`); `npm run verify:commercial:report -- --write` cleanly generated `docs/COMMERCIAL_VERIFICATION_REPORT.md` showing `ALL_EXTERNAL_BLOCKED`.

### Task F — Clear Distinction Between Public Store Discovery & Full Shopify OAuth Sync
- **Implementation:**
  - Explicitly labels unauthenticated `/products.json?limit=25` checks as **Public Store Discovery — Limited Sample (25-product sample, subject to CORS — not a full website crawl)** and separates them structurally and visually from **Full Shopify Catalog Sync (Authenticated OAuth)** (`src/domain/ingestion/storeIngestion.ts`, `src/pages/LandingPage.tsx`, `src/pages/HomePage.tsx`, `src/pages/ProductsPage.tsx`, `src/pages/ProductDetailPage.tsx`).
  - Documented in `README.md` Sections 7 and 9.
- **Verification:** `src/domain/ingestion/publicVsOAuthSync.test.ts`, `src/domain/catalogImport.test.ts`, `src/domain/actionMutation.test.ts`, `src/server/remediationVerification.test.ts`, `src/server/productionReadiness.test.ts`, `src/pages/LandingPage.billing.test.ts`, and `src/pages/SettingsPage.billingShopify.test.ts` (`PASS`).

---

## C. Environment, Database Migrations & Security Audit

1. **Zero Secret Leakage & Clean ENV Parity:**
   - Verified `.env` does **not** exist in `/app/applet`.
   - Audited every `process.env.*` reference in `server.ts` and `src/` against `.env.example`; all variables are documented with safe non-secret defaults/placeholders.
2. **PostgreSQL Migrations (`001`–`019`):**
   - Existing migrations `001_initial_schema.sql` through `018_guest_transfer_authorizations.sql` remain unmodified.
   - New additive migration `019_writeback_and_billing_emails.sql` defines `shopify_writeback_operations` and `billing_email_deliveries` tables + indexes.
   - `.github/workflows/ci.yml` updated to reference Migrations `001-019`.
3. **Preserved Business & Security Invariants:**
   - Authoritative pricing unchanged (`Starter` $49/mo, `Growth` $149/mo, `Enterprise` $499/mo).
   - Cookie-only browser auth (`aixshop_session`), CSRF protection (`X-Requested-With`), AES-256-GCM Shopify token encryption, and HMAC webhook verification preserved without weakening.
4. **Known Workspace Limitation:**
   - No `.git` directory or Git remote exists in the local `/app/applet` workspace; all changes reside locally and have not been committed or pushed to GitHub.

---

## D. Verification Truth Matrix

| Stage / Scope | Status | Verification Basis |
| --- | --- | --- |
| Client Build, TypeScript Lint, Static Security & Config Validation | **PASS** | Directly executed (`tsc --noEmit`, `vite build`, `config:check`, static grep) |
| Unit, Domain Ingestion, Auth, Tenant Isolation, Remediation & Mock-Pool PG Tests | **PASS** | Directly executed (`npm test`, `npm run test:unit`, `npm run test:postgres` non-live specs) |
| 30-Step Journey, Commercial Contract Harness, Write-Back & Billing Email Suites | **PASS — SIMULATED** | Executed locally using `MemoryRepository`, `SandboxBillingProvider`, mocked Shopify fetch, and `node:net` loopback SMTP |
| Stage 0 — Live PostgreSQL 16 (`db:migrate`, `db:status`, 7 live PG tests) | **BLOCKED** | Missing `DATABASE_URL` (or `SQL_HOST` / `PGHOST`) |
| Stage 1 — Shopify Development Store (`npm run verify:shopify`) | **BLOCKED** | Missing `COMMERCIAL_VERIFY_EXTERNAL=true`, Partner keys, encryption key, and Dev Store domain/token (`BLOCKED` 5/5) |
| Stage 2 — Stripe Test Mode (`npm run verify:stripe`) | **BLOCKED** | Missing `COMMERCIAL_VERIFY_EXTERNAL=true`, `sk_test_...`, `whsec_...`, and authoritative Price IDs (`BLOCKED` 5/5) |
| Stage 3 — Real SMTP Provider (`npm run verify:smtp` + Inbox Receipt) | **BLOCKED** | Missing `COMMERCIAL_VERIFY_EXTERNAL=true`, SMTP credentials, verified non-`.local` sender, and `SMTP_TEST_RECIPIENT` (`BLOCKED` 3/3) |
| Stage 4 — Staging End-to-End Customer Journey (`npm run verify:staging-e2e`) | **BLOCKED** | Missing `COMMERCIAL_VERIFY_EXTERNAL=true`, `STAGING_BASE_URL`, `STAGING_CONFIRM_NON_PRODUCTION=true`, and Stage 1–3 credentials (`BLOCKED` 7/7) |

---

## E. Next Steps When Real Credentials Are Ready

1. Provision PostgreSQL 16 + staging environment variables externally (never commit `.env`), following `docs/COMMERCIAL_VERIFICATION_GUIDE.md`.
2. Run database migrations and verify schema checksums:
   ```bash
   npm run db:migrate && npm run db:status && npm run test:postgres
   ```
3. Run live commercial verification stages (`COMMERCIAL_VERIFY_EXTERNAL=true`) and regenerate the commercial report:
   ```bash
   npm run verify:shopify
   npm run verify:stripe
   npm run verify:smtp
   npm run verify:staging-e2e
   npm run verify:commercial:report -- --write
   ```
4. Complete manual browser/inbox checks in `docs/MANUAL_EXTERNAL_VERIFICATION_CHECKLIST.md` and record signed evidence in `docs/COMMERCIAL_VERIFICATION_EVIDENCE_TEMPLATE.md`.
