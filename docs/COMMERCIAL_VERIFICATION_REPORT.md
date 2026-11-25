# AIXSHOP v1.0 — Commercial Integration Verification Report

- **Generated At:** 2026-11-25T13:42:48.139Z
- **Run ID:** `cv_1795614168143_88982e90`
- **Target Environment:** `development`
- **External Verification Opt-In (`COMMERCIAL_VERIFY_EXTERNAL`):** DISABLED (BLOCKED)
- **Overall External Verification Status:** **BLOCKED**
- **Cleanup Performed:** No (no external test artifacts created or skipped)

## Status Model
- `PASS`: Executed against the intended target with verifiable evidence.
- `FAIL`: Executed and failed.
- `BLOCKED`: Cannot execute because required credentials, targets, or opt-in activation are missing.
- `NOT RUN`: Not yet executed.

## Stage Readiness Summary

| Stage | Status | Pass | Fail | Blocked | Not Run | Missing / Blocking Prerequisites |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Stage 0 — Secret-Safe Environment & Infrastructure Readiness | **BLOCKED** | 1 | 0 | 1 | 0 | `DATABASE_URL (or SQL_HOST / PGHOST)`, `SHOPIFY_TOKEN_ENCRYPTION_KEY` |
| Stage 1 — Shopify Development Store | **BLOCKED** | 0 | 0 | 5 | 0 | `COMMERCIAL_VERIFY_EXTERNAL=true`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_TOKEN_ENCRYPTION_KEY`, `SHOPIFY_DEV_STORE_DOMAIN`, `SHOPIFY_DEV_ACCESS_TOKEN` |
| Stage 2 — Stripe Test Mode | **BLOCKED** | 0 | 0 | 5 | 0 | `COMMERCIAL_VERIFY_EXTERNAL=true`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER (missing)`, `STRIPE_PRICE_GROWTH (missing)`, `STRIPE_PRICE_ENTERPRISE (missing)` |
| Stage 3 — Real SMTP Provider | **BLOCKED** | 0 | 0 | 3 | 0 | `COMMERCIAL_VERIFY_EXTERNAL=true`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM (non-.local verified sender address required for real provider)`, `SMTP_TEST_RECIPIENT` |
| Stage 4 — Staging End-to-End Customer Journey | **BLOCKED** | 0 | 0 | 5 | 0 | `COMMERCIAL_VERIFY_EXTERNAL=true`, `STAGING_BASE_URL`, `STAGING_CONFIRM_NON_PRODUCTION=true`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_TOKEN_ENCRYPTION_KEY`, `SHOPIFY_DEV_STORE_DOMAIN`, `SHOPIFY_DEV_ACCESS_TOKEN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER (missing)`, `STRIPE_PRICE_GROWTH (missing)`, `STRIPE_PRICE_ENTERPRISE (missing)`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM (non-.local verified sender address required for real provider)`, `SMTP_TEST_RECIPIENT` |

## Detailed Check Matrix

### Stage 0 — Secret-Safe Environment & Infrastructure Readiness (BLOCKED)

| Test ID | Check | Execution Mode | Status | Blocker / Evidence |
| --- | --- | --- | --- | --- |
| `S0-LOCAL-CONFIG` | Local application config check (npm run config:check) | `unit_mock` | **PASS** | {"checks":{"postgresConfigured":false,"appUrlValid":true,"encryptionKeyValid":false,"billingConfigValid":true,"stripePriceIdsValid":true,"smtpConfigValid":true,"shopifyConfigValid":true,"trustProxyValid":true,"devOverridesDisabled":true,"rateLimitPolicyValid":true,"shopifyUrlsValid":true}} |
| `S0-POSTGRES-TARGET` | PostgreSQL target availability (DATABASE_URL / SQL_HOST) | `local_postgres` | **BLOCKED** | Missing prerequisites: DATABASE_URL (or SQL_HOST / PGHOST) |

### Stage 1 — Shopify Development Store (BLOCKED)

| Test ID | Check | Execution Mode | Status | Blocker / Evidence |
| --- | --- | --- | --- | --- |
| `S1-OAUTH-URL` | Shopify OAuth connect initiation & state/HMAC verification | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_TOKEN_ENCRYPTION_KEY, SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_ACCESS_TOKEN |
| `S1-ADMIN-AUTH` | Shopify Development Store Admin GraphQL authentication | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_TOKEN_ENCRYPTION_KEY, SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_ACCESS_TOKEN |
| `S1-PRODUCT-PAGINATION` | Shopify cursor-based product pagination & sync integrity | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_TOKEN_ENCRYPTION_KEY, SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_ACCESS_TOKEN |
| `S1-WEBHOOK-HMAC-DEDUP` | Shopify webhook HMAC verification & subscription audit | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_TOKEN_ENCRYPTION_KEY, SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_ACCESS_TOKEN |
| `S1-TEST-PRODUCT-LIFECYCLE` | Shopify safe test product create & cleanup (opt-in) | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_TOKEN_ENCRYPTION_KEY, SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_ACCESS_TOKEN |

### Stage 2 — Stripe Test Mode (BLOCKED)

| Test ID | Check | Execution Mode | Status | Blocker / Evidence |
| --- | --- | --- | --- | --- |
| `S2-KEY-SAFETY-GUARD` | Stripe Test Mode key safety guard (reject sk_live_) | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER (missing), STRIPE_PRICE_GROWTH (missing), STRIPE_PRICE_ENTERPRISE (missing) |
| `S2-PRICE-INTEGRITY` | Stripe Test Mode authoritative Price ID verification | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER (missing), STRIPE_PRICE_GROWTH (missing), STRIPE_PRICE_ENTERPRISE (missing) |
| `S2-CHECKOUT-SESSION` | Stripe Test Mode Checkout Session creation & metadata mapping | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER (missing), STRIPE_PRICE_GROWTH (missing), STRIPE_PRICE_ENTERPRISE (missing) |
| `S2-WEBHOOK-SIGNATURE-EVENTS` | Stripe webhook HMAC signature & supported event lifecycle processing | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER (missing), STRIPE_PRICE_GROWTH (missing), STRIPE_PRICE_ENTERPRISE (missing) |
| `S2-SUBSCRIPTION-LIFECYCLE` | Stripe Test Mode Subscription creation, plan change, cancel & cleanup | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER (missing), STRIPE_PRICE_GROWTH (missing), STRIPE_PRICE_ENTERPRISE (missing) |

### Stage 3 — Real SMTP Provider (BLOCKED)

| Test ID | Check | Execution Mode | Status | Blocker / Evidence |
| --- | --- | --- | --- | --- |
| `S3-CONFIG-POLICY` | SMTP host, port, TLS/STARTTLS, auth & sender validation | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM (non-.local verified sender address required for real provider), SMTP_TEST_RECIPIENT |
| `S3-HANDSHAKE-AUTH` | Live SMTP TCP/TLS/STARTTLS & AUTH handshake verification | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM (non-.local verified sender address required for real provider), SMTP_TEST_RECIPIENT |
| `S3-SMOKE-SEND` | Real SMTP smoke-test message send & relay acceptance | `external_provider` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM (non-.local verified sender address required for real provider), SMTP_TEST_RECIPIENT |

### Stage 4 — Staging End-to-End Customer Journey (BLOCKED)

| Test ID | Check | Execution Mode | Status | Blocker / Evidence |
| --- | --- | --- | --- | --- |
| `S4-STAGING-HEALTH-ISOLATION` | Staging readiness probe & non-production safety guard | `staging_e2e` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, STAGING_BASE_URL, STAGING_CONFIRM_NON_PRODUCTION=true, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_TOKEN_ENCRYPTION_KEY, SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_ACCESS_TOKEN, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER (missing), STRIPE_PRICE_GROWTH (missing), STRIPE_PRICE_ENTERPRISE (missing), SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM (non-.local verified sender address required for real provider), SMTP_TEST_RECIPIENT |
| `S4-ACCOUNT-WORKSPACE-FREE` | Customer account registration, workspace creation & Free Audit initial state | `staging_e2e` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, STAGING_BASE_URL, STAGING_CONFIRM_NON_PRODUCTION=true, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_TOKEN_ENCRYPTION_KEY, SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_ACCESS_TOKEN, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER (missing), STRIPE_PRICE_GROWTH (missing), STRIPE_PRICE_ENTERPRISE (missing), SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM (non-.local verified sender address required for real provider), SMTP_TEST_RECIPIENT |
| `S4-SHOPIFY-OAUTH-CONNECT-INIT` | Shopify Dev Store connect initiation from staging workspace | `staging_e2e` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, STAGING_BASE_URL, STAGING_CONFIRM_NON_PRODUCTION=true, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_TOKEN_ENCRYPTION_KEY, SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_ACCESS_TOKEN, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER (missing), STRIPE_PRICE_GROWTH (missing), STRIPE_PRICE_ENTERPRISE (missing), SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM (non-.local verified sender address required for real provider), SMTP_TEST_RECIPIENT |
| `S4-STRIPE-CHECKOUT-AND-NEGATIVES` | Stripe Test Mode Checkout session & negative security guards on staging | `staging_e2e` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, STAGING_BASE_URL, STAGING_CONFIRM_NON_PRODUCTION=true, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_TOKEN_ENCRYPTION_KEY, SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_ACCESS_TOKEN, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER (missing), STRIPE_PRICE_GROWTH (missing), STRIPE_PRICE_ENTERPRISE (missing), SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM (non-.local verified sender address required for real provider), SMTP_TEST_RECIPIENT |
| `S4-SMTP-FORGOT-PASSWORD` | Staging transactional SMTP flow trigger (password reset) | `staging_e2e` | **BLOCKED** | Missing prerequisites: COMMERCIAL_VERIFY_EXTERNAL=true, STAGING_BASE_URL, STAGING_CONFIRM_NON_PRODUCTION=true, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_TOKEN_ENCRYPTION_KEY, SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_ACCESS_TOKEN, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER (missing), STRIPE_PRICE_GROWTH (missing), STRIPE_PRICE_ENTERPRISE (missing), SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM (non-.local verified sender address required for real provider), SMTP_TEST_RECIPIENT |

## Notes & Guardrails
- Unit and contract tests using mocks/fixtures verify internal correctness only and never count as external provider verification.
- SMTP relay acceptance (250 OK) is distinct from confirmed recipient inbox delivery.
- When external credentials or COMMERCIAL_VERIFY_EXTERNAL=true are absent, stages report BLOCKED — never PASS.
