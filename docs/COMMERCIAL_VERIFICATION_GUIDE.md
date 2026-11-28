# AIXSHOP v1.0 — Commercial Integration Verification Playbook

This guide documents how to prepare, execute, record evidence for, and clean up the four external commercial integration verification stages for **AIXSHOP v1.0**.

> **Truthfulness Policy:** Unit tests, mocked contract suites, and local loopback responders verify internal code correctness only (`[CONTRACT / SIMULATED]`). Real external verification requires `COMMERCIAL_VERIFY_EXTERNAL=true` plus genuine external credentials/targets. Missing credentials always report `BLOCKED` — never `PASS`.

---

## Status Model

| Status | Meaning |
| --- | --- |
| `PASS` | Executed against the intended real target with verifiable evidence |
| `PASS — SIMULATED` | Executed end-to-end using local mocks, fixtures, or test doubles only (never live external providers) |
| `FAIL` | Executed and failed |
| `BLOCKED` | Cannot execute because credentials, configuration, or external resources are missing |
| `NOT RUN` | Not yet executed |

---

## Separated Verification & Test Categories

- **Unit tests (domain/client logic):** `npm run test:unit`
- **Integration contract & local loopback tests (CI-safe, no external APIs):** `npm run test:contracts`
- **Local / CI PostgreSQL tests (requires `DATABASE_URL` or `SQL_HOST`):** `npm run test:postgres`
- **Full CI-safe suite:** `npm test`
- **Secret-safe runtime config check:** `npm run config:check`
- **Secret-safe commercial readiness check:** `npm run verify:config`
- **External stage runners (require explicit opt-in & credentials):**
  - Stage 1 (Shopify Dev Store): `npm run verify:shopify`
  - Stage 2 (Stripe Test Mode): `npm run verify:stripe`
  - Stage 3 (Real SMTP Provider): `npm run verify:smtp`
  - Stage 4 (Staging E2E): `npm run verify:staging-e2e`
  - **Verified local simulated orchestration (recommended):** `npm run verify:simulated` (or `bun run verify:simulated`) — generates a fresh ephemeral 256-bit HMAC-SHA-256 signing key strictly in memory, runs all 4 simulated suites (`run-simulated-tests.ts`), checks source-file SHA-256 before and after each suite execution, signs canonical evidence payloads (including captured-output SHA-256), evaluates the signed `reports/simulated-test-results.json` with the same ephemeral key, writes `docs/COMMERCIAL_VERIFICATION_REPORT.md`, and discards the key.
  - Low-level runner / report commands (require `SIMULATED_ARTIFACT_HMAC_KEY` from the orchestrator or CI shell when evaluating simulated evidence): `npm run test:simulated:artifact` and `npm run verify:commercial:report -- --write`.

Add `--strict` to any `verify:*` command to exit non-zero (`2`) if any check is `BLOCKED` (useful as a pre-release gate).

### Simulated Artifact Integrity & Evidence Separation

1. **Source SHA-256 verification (before, during, and after):** `run-simulated-tests.ts` computes each suite file's SHA-256 immediately before and immediately after execution. If a suite source file changes during execution, the suite is marked `FAIL` (`sourceChangedDuringRun: true`) and rejected. When evaluating `reports/simulated-test-results.json`, the evaluator recalculates each current test suite file's SHA-256 on disk and compares it via `crypto.timingSafeEqual` against `entry.sha256`.
2. **Captured-output SHA-256 (`outputSha256`) & Ephemeral HMAC-SHA-256 verification:** The runner computes `outputSha256` over the captured runner stdout/stderr and signs canonical JSON payloads covering `schemaVersion`, `runId`, `generatedAt`, `runner`, `nodeVersion` (when present), `suiteId`, `suiteFile`, `executedAt`, `durationMs`, `exitCode`, `passedCount`, `failedCount`, `skippedCount`, `totalCount`, `status`, `sha256`, `outputSha256`, and `sourceChangedDuringRun` (if set) at both suite and root-artifact levels using a fresh per-run ephemeral `SIMULATED_ARTIFACT_HMAC_KEY`.
3. **Key handling & fail-closed behavior:** The ephemeral key is never written into `reports/simulated-test-results.json`, printed to logs, or committed to Git. If the key is missing, invalid, or mismatched—or if counts, exit codes, signatures, digests, or `suiteId <-> suiteFile` mappings fail validation—the evaluator never emits `PASS — SIMULATED` (missing artifact -> `NOT RUN`; tampered/unsigned/corrupt/failed -> `FAIL`).
4. **Trust boundaries & limits of simulated evidence:** Source SHA-256 detects changes to the suite file on disk (before/during/after the run). Ephemeral HMAC-SHA-256 authenticates that the recorded counts, statuses, timestamps, and output digest match what that run's runner produced under the in-memory ephemeral key. Neither proves that the mocked test logic covers real external provider behavior or that the runner environment itself was immune to compromise. `PASS — SIMULATED` (`liveProviderVerified: false`) remains strictly separate from live external verification (`PASS`) across Shopify, Stripe, SMTP, and staging E2E.

---

## Stage 1 — Shopify Development Store Verification

### Prerequisites & Partner Setup
1. In the **Shopify Partner Dashboard**, create a **Development Store** (`<store-handle>.myshopify.com`) and a custom/public **Shopify App**.
2. Set App URL to your HTTPS deployment (`SHOPIFY_APP_URL`) and Allowed Redirection URL to `{SHOPIFY_APP_URL}/api/shopify/callback` (`SHOPIFY_REDIRECT_URI`).
3. Configure Admin API scopes: `read_products` (add `write_products` only if testing opt-in temporary product create/delete).
4. Generate a 256-bit token encryption key:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
5. Obtain the Dev Store offline Admin API access token via OAuth install or custom app install.

### Required ENV Variables
- `COMMERCIAL_VERIFY_EXTERNAL="true"`
- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_TOKEN_ENCRYPTION_KEY`
- `SHOPIFY_APP_URL` / `SHOPIFY_REDIRECT_URI` / `SHOPIFY_WEBHOOK_URL`
- `SHOPIFY_DEV_STORE_DOMAIN` (e.g. `aixshop-dev-store.myshopify.com`)
- `SHOPIFY_DEV_ACCESS_TOKEN` (offline `shpat_...` token for the Dev Store)
- Optional write test: `SHOPIFY_ALLOW_TEST_PRODUCT_MUTATION="true"`, `SHOPIFY_TEST_PRODUCT_PREFIX="AIXSHOP-VERIFY-"`

### Execution
```bash
npm run verify:shopify
```

### Safe Test Data & Cleanup
- By default, `verify:shopify` runs read-only GraphQL catalog pagination (`pageSize=5`), OAuth state/HMAC checks, and webhook subscription inspection (comparing registered topics and `callbackUrl` values against `DEFAULT_SHOPIFY_WEBHOOK_TOPICS` and `SHOPIFY_WEBHOOK_URL` / `SHOPIFY_APP_URL` / `APP_URL`).
- Local HMAC signature verification (`S1-WEBHOOK-HMAC-SIMULATION`) is reported separately as `PASS — SIMULATED` and does not prove real Shopify webhook delivery (`S1-WEBHOOK-LIVE-DELIVERY` remains `NOT RUN` until verified against a deployed endpoint).
- If `SHOPIFY_ALLOW_TEST_PRODUCT_MUTATION=true`, it creates one `DRAFT` product prefixed `AIXSHOP-VERIFY-`, deletes it inside a `finally` block, verifies the `productDelete` response, and performs a follow-up GraphQL `product(id)` read to confirm deletion before reporting `cleanedUp=true`.
- If interrupted abnormally, delete any leftover `AIXSHOP-VERIFY-*` draft products in Shopify Admin > Products and revoke/rotate test credentials if no longer needed.

---

## Stage 2 — Stripe Test Mode Verification

### Prerequisites & Setup
1. Switch the Stripe Dashboard to **Test mode** (`sk_test_...`). **Never** use a live key (`sk_live_...`); `verify:stripe` and `verify:staging-e2e` explicitly reject live keys.
2. Create three recurring monthly USD Prices matching AIXSHOP authoritative tiers:
   - Starter: `$49.00 / month` (`STRIPE_PRICE_STARTER`)
   - Growth: `$149.00 / month` (`STRIPE_PRICE_GROWTH`)
   - Enterprise: `$499.00 / month` (`STRIPE_PRICE_ENTERPRISE`)
3. For local/staging webhook forwarding via Stripe CLI:
   ```bash
   stripe listen --forward-to http://localhost:3000/api/billing/webhook
   ```
   Copy the emitted `whsec_...` into `STRIPE_WEBHOOK_SECRET`.
4. Supported webhook events verified by AIXSHOP (`src/server/services/billingService.ts`):
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded` / `invoice.paid`
   - `invoice.payment_failed`
   - `charge.refunded`
   - Unhandled/unsupported events (e.g., `customer.discount.created`) are safely acknowledged/ignored without mutating subscription state.

### Required ENV Variables
- `COMMERCIAL_VERIFY_EXTERNAL="true"`
- `STRIPE_SECRET_KEY` (`sk_test_...`)
- `STRIPE_WEBHOOK_SECRET` (`whsec_...`)
- `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_ENTERPRISE`
- Optional: `STRIPE_TEST_CUSTOMER_EMAIL`, `STRIPE_TEST_CLOCK_ENABLED="true"` (creates and advances a real Stripe Test Clock via `testHelpers.testClocks.advance()`, verifies `subscription_cycle` paid invoice renewal, upgrade to Growth, `cancel_at_period_end`, and immediate cancellation)

### Execution & Test Cards
```bash
npm run verify:stripe
```
- `S2-CHECKOUT-SESSION` creates and retrieves real Checkout Sessions for both **Starter** and **Growth**, verifying customer association, URL, `workspaceId`, and `tier` metadata.
- `S2-WEBHOOK-LOCAL-SIMULATION` exercises local HMAC signing and `BillingService` against `MemoryRepository` (`PASS — SIMULATED`), kept strictly separate from real deployed Stripe webhook delivery (`S2-WEBHOOK-LIVE-DELIVERY`, `NOT RUN`).
For interactive Stripe Checkout testing in Stage 4:
- Successful payment: `4242 4242 4242 4242` (any future expiry/CVC)
- Declined / failed payment: `4000 0000 0000 0002` (or `pm_card_chargeDeclined` in API tests)

### Cleanup
- `verify:stripe` expires uncompleted temporary Checkout Sessions, deletes temporary Test Customers (`aixshop_verification=true`), and deletes created Test Clocks in a `finally` block (`S2-STRIPE-CLEANUP`), verifying each outcome and failing if cleanup fails.
- Inspect Stripe Dashboard (Test mode) > Customers / Test Clocks after manual runs to remove any remaining test objects.

---

## Stage 3 — Real SMTP Provider Verification

### Prerequisites & Setup
1. Provision credentials from an SMTP provider (e.g., Mailtrap Email Testing, Postmark, SendGrid, Amazon SES, Resend SMTP).
2. Configure TLS (`SMTP_PORT=465`, `SMTP_SECURE=true`) or STARTTLS (`SMTP_PORT=587`, `SMTP_STARTTLS=true`) with `SMTP_REJECT_UNAUTHORIZED=true`.
3. Use a verified non-`.local` sender domain in `SMTP_FROM` and set `SMTP_TEST_RECIPIENT` to a controlled inbox you own.

### Required ENV Variables
- `COMMERCIAL_VERIFY_EXTERNAL="true"`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_STARTTLS`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_REJECT_UNAUTHORIZED`
- `SMTP_TEST_RECIPIENT` (explicit target required so tests never send unsolicited email)

### Execution
```bash
npm run verify:smtp
```

### Delivery Acceptance vs Inbox Receipt
- `smtp_configuration_valid`: static validation of host, port, TLS policy, credentials, sender address.
- `smtp_connection_verified`: live TCP + TLS/STARTTLS + `EHLO` + `AUTH` handshake succeeded.
- `smtp_message_accepted`: SMTP server returned `250 OK` after `DATA`.
- `inbox_delivery_confirmed`: remains `false` during SMTP smoke test because relay acceptance (`250 OK`) does not prove recipient inbox placement. Confirm inbox receipt manually or via your provider's webhook/delivery API and record it in the evidence template.

### Implemented Transactional & Billing Email Event Matrix

All transactional email rendering and SMTP/transport dispatch live in `src/server/services/emailService.ts`, while billing lifecycle triggers and idempotent delivery tracking live in `src/server/services/billingService.ts` (`billing_email_deliveries` table in Migration `019`).

- **Implemented vs. Verified Scope:** Password reset and all 5 billing lifecycle emails are **implemented** and **verified in local unit/integration/loopback-SMTP tests (`PASS — SIMULATED`)**. **Real external SMTP delivery remains `BLOCKED — SMTP ENV NOT CONFIGURED`** until `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, non-`.local` `SMTP_FROM`, `SMTP_TEST_RECIPIENT`, and `COMMERCIAL_VERIFY_EXTERNAL=true` are provided. **Do not claim Production Ready for email delivery until real SMTP relay acceptance and recipient inbox receipt are verified.**
- **Webhook Security & Tenant Isolation:** `POST /api/billing/webhook` verifies cryptographic signatures over raw request bytes (`provider.verifyWebhookSignature`) and enforces atomic event claims (`claimBillingEvent`). Recipients are resolved per workspace via `repo.getWorkspaceBillingRecipient(workspaceId)`, and `GET /api/billing/email-deliveries` strictly filters by the authenticated `req.workspace!.id`.
- **Non-Blocking Failure & Retry:** Billing email dispatch (`dispatchBillingLifecycleEmail`) is non-blocking so SMTP errors never roll back subscription transitions; failed sends record sanitized errors (`sanitizeSmtpErrorMessage`) with `status = 'failed'` and `next_retry_at = +60s`. `retryFailedBillingEmails(repo)` (`src/server/services/billingService.ts`) retries eligible failed rows cleanly, though `server.ts` does not schedule `retryFailedBillingEmails` on an automatic background interval.

| Email Event | Trigger (Verified from Source Code) | Function / Source File | Duplicate Protection | Retry / Failure Handling | Test Evidence |
| --- | --- | --- | --- | --- | --- |
| **Checkout Confirmation** | `createCheckoutSession` sends **0** emails. Confirmation is emitted after payment verification (`verifyCheckoutSession`) or `checkout.session.completed` webhook when `payment_status` is `'paid'` or `'no_payment_required'` (`initial_payment_confirmed`). | `BillingService.verifyCheckoutSession` & `BillingService.processEvent` (`src/server/services/billingService.ts`); `sendBillingLifecycleEmail` (`src/server/services/emailService.ts`) | Shared `deliveryKey`: `billing_email:initial:${workspaceId}:${subscriptionId}` enforced by `UNIQUE(delivery_key)` in `createOrClaimBillingEmailDelivery` + webhook `claimBillingEvent` | Non-blocking; failed sends persist `status='failed'` + `nextRetryAt=+60s` for `retryFailedBillingEmails(repo)` | **Unit/Integration/Loopback SMTP:** `PASS — SIMULATED` (`billingEmail.test.ts`, `customerJourney30Step.e2e.test.ts`) · **Real SMTP:** `BLOCKED — SMTP ENV NOT CONFIGURED` |
| **Payment Confirmation** | Same `initial_payment_confirmed` lifecycle event as above; `invoice.payment_succeeded` / `invoice.paid` with `billing_reason='subscription_create'` explicitly skips sending a duplicate renewal email. | `BillingService.verifyCheckoutSession` & `checkout.session.completed` (`src/server/services/billingService.ts`) | Shared `deliveryKey` deduplicates `verifyCheckoutSession` vs. `checkout.session.completed` in either arrival order; `subscription_create` invoice skipped | Non-blocking; persisted in `billing_email_deliveries`; retriable via `retryFailedBillingEmails(repo)` | **Unit/Integration/Loopback SMTP:** `PASS — SIMULATED` (`billingEmail.test.ts`, `customerJourney30Step.e2e.test.ts`) · **Real SMTP:** `BLOCKED — SMTP ENV NOT CONFIGURED` |
| **Subscription Created** | **No separate email event exists.** Initial `customer.subscription.created` with no prior subscription emits **0** emails (covered once by `initial_payment_confirmed`). Only emits `plan_changed` if `existingSub` existed with a different tier, or `subscription_canceled` if `cancel_at_period_end` flips `false -> true`. | `BillingService.processEvent` (`case 'customer.subscription.created'`, `src/server/services/billingService.ts`) | N/A when no prior sub; uses `plan_changed` / `canceled_scheduled` `deliveryKey` when transitioning an existing sub | Inherits `dispatchBillingLifecycleEmail` ledger & `retryFailedBillingEmails(repo)` | **Code Audit + Integration:** `PASS — SIMULATED` (`billingEmail.test.ts` skips `subscription_create` invoice; `billingService.ts` verified) · **Real SMTP:** `BLOCKED — SMTP ENV NOT CONFIGURED` |
| **Subscription Updated** | 1) Tier change on active/trialing existing sub (`customer.subscription.created/updated`) -> `plan_changed`.<br>2) Paid renewal (`invoice.payment_succeeded` / `invoice.paid` with `billing_reason !== 'subscription_create'`) -> `recurring_renewal`. | `BillingService.processEvent` (`src/server/services/billingService.ts`); `renderBillingLifecycleEmail` (`src/server/services/emailService.ts`) | `billing_email:plan_changed:${workspaceId}:${event.id}` & `billing_email:renewal:${workspaceId}:${invoiceIdOrEventId}` + webhook `claimBillingEvent` | Non-blocking; persisted in `billing_email_deliveries`; retriable via `retryFailedBillingEmails(repo)` | **Unit/Integration/Loopback SMTP:** `PASS — SIMULATED` (`billingEmail.test.ts`, `customerJourney30Step.e2e.test.ts`) · **Real SMTP:** `BLOCKED — SMTP ENV NOT CONFIGURED` |
| **Subscription Cancelled** | 1) `cancel_at_period_end` flips `false -> true` (`customer.subscription.updated`).<br>2) `customer.subscription.deleted`.<br>3) Full refund (`charge.refunded` with `isFullRefund=true`). All emit `subscription_canceled`. | `BillingService.processEvent` (`src/server/services/billingService.ts`); `sendBillingLifecycleEmail` (`src/server/services/emailService.ts`) | Distinct `deliveryKey`s (`canceled_scheduled:...`, `canceled:...:deleted`, `canceled:...:refunded:${event.id}`) + webhook `claimBillingEvent` | Non-blocking; persisted in `billing_email_deliveries`; retriable via `retryFailedBillingEmails(repo)` | **Integration/Loopback SMTP:** `PASS — SIMULATED` (`customer.subscription.deleted` in `billingEmail.test.ts`, `customerJourney30Step.e2e.test.ts`) · **Real SMTP:** `BLOCKED — SMTP ENV NOT CONFIGURED` |
| **Payment Failed** | `invoice.payment_failed` webhook when workspace & non-canceled subscription exist (and event is not stale) -> sets `past_due` and emits `payment_failed`. | `BillingService.processEvent` (`case 'invoice.payment_failed'`, `src/server/services/billingService.ts`); `sendBillingLifecycleEmail` (`src/server/services/emailService.ts`) | `deliveryKey`: `billing_email:payment_failed:${workspaceId}:${invoiceIdOrEventId}` + webhook `claimBillingEvent` | Non-blocking; persisted in `billing_email_deliveries`; retriable via `retryFailedBillingEmails(repo)` | **Integration/Loopback SMTP:** `PASS — SIMULATED` (`billingEmail.test.ts`, `customerJourney30Step.e2e.test.ts`) · **Real SMTP:** `BLOCKED — SMTP ENV NOT CONFIGURED` |
| **Password Reset** *(Auth)* | `POST /api/auth/forgot-password` for an existing user email with valid `SMTP` / transport availability. | `authRoutes.ts` -> `sendPasswordResetEmail` (`src/server/services/emailService.ts`) | Single-use SHA-256 reset token (`password_reset_tokens`, Migration `014`) + non-enumeration response | On send failure, token is immediately invalidated (`markPasswordResetTokenConsumed`) without exposing account existence | **Integration/Loopback SMTP:** `PASS — SIMULATED` (`stripeAndSmtpReadiness.test.ts`, `customerJourney30Step.e2e.test.ts`) · **Real SMTP:** `BLOCKED — SMTP ENV NOT CONFIGURED` |

---

## Stage 4 — Staging End-to-End Customer Journey

### Prerequisites & Safety Guardrails
1. Deploy AIXSHOP to an **isolated staging environment** (`STAGING_BASE_URL`, `https://` required for remote targets) connected to a **staging PostgreSQL database** (migrations `001`–`019` applied).
2. **Understand `NODE_ENV`, `APP_URL`, `PRODUCTION_HOSTS`, and `PRODUCTION_APP_URL`:**
   - `NODE_ENV` selects runtime configuration (a staging deployment commonly runs `NODE_ENV=production` to match production runtime policies).
   - `APP_URL` identifies the URL of **the currently deployed instance** (which may be a staging deployment running `NODE_ENV=production`), so `APP_URL` is **never** automatically treated as production denylist identity.
   - `PRODUCTION_HOSTS` (comma-separated exact DNS hostnames, e.g. `PRODUCTION_HOSTS="shop.customer.com,checkout.customer.com"`) and `PRODUCTION_APP_URL` (your authoritative `https://` customer-facing production URL) form the **explicit authoritative production denylist**.
3. **Explicit Denylist + Explicit Allowlist for Remote Staging:**
   - Remote staging verification **requires** a valid, non-empty production denylist (`PRODUCTION_HOSTS` and/or `PRODUCTION_APP_URL`). If both are empty, remote staging **fails closed** before any HTTP call (`PRODUCTION_DENYLIST_MISSING`).
   - Explicitly allowlist the exact staging hostname in `STAGING_ALLOWED_HOSTS` (comma-separated exact DNS hostnames without schemes, ports, paths, or wildcards; e.g. `STAGING_ALLOWED_HOSTS="staging.aixshop.example.com"`). No substring heuristics (such as matching `"staging"` or `"dev"` in a hostname) are used.
   - Local loopback (`http://127.0.0.1` / `localhost`) is rejected in remote mode and permitted only when `STAGING_ALLOW_LOCAL="true"` for isolated local test servers.
   - Production host rejection applies **regardless of `NODE_ENV`**, runs **before** `STAGING_ALLOWED_HOSTS` / `STAGING_ALLOW_LOCAL`, rejects any staging target or allowlist containing a production host (`PRODUCTION_TARGET_REJECTED`), and fails closed on malformed or contradictory configuration.
   - A staging instance running `NODE_ENV=production` with `APP_URL=https://staging.aixshop.example.com` is accepted when `STAGING_BASE_URL` matches `STAGING_ALLOWED_HOSTS`, is excluded from the production denylist, and a valid explicit production denylist is configured.
4. Set `STAGING_CONFIRM_NON_PRODUCTION="true"` and configure Shopify Dev Store, Stripe Test Mode (`sk_test_...`), and Real SMTP env vars on both the staging deployment and verification runner.
5. Never point `STAGING_BASE_URL` at production, include embedded URL credentials (`user:pass@`), use remote `http://`, or supply a live Stripe key (`STAGING_CONFIRM_NON_PRODUCTION=true` and `STAGING_ALLOWED_HOSTS` never bypass the production denylist).

### Required Evidence Before Staging or Production Verification
- Fresh `reports/simulated-test-results.json` verified via `npm run verify:simulated` (`hmacVerified: true`, `sha256Verified: true`, valid `outputSha256`, and all 4 simulated checks in `PASS — SIMULATED`)
- Secret-safe environment audit (`npm run config:check` and `npm run verify:config`) confirming non-production staging target, explicit `PRODUCTION_HOSTS` / `PRODUCTION_APP_URL` denylist, `STAGING_ALLOWED_HOSTS`, and `sk_test_...` only
- Stage 1–3 evidence logs (Shopify Dev Store GraphQL read + webhook registration, Stripe Test Mode checkout/prices + cleanup, Real SMTP `250 OK` + manual inbox receipt) and Stage 4 cleanup confirmation before claiming staging/commercial readiness.

### Multi-Step Customer Journey & Negative Scenarios
Automated runner (`npm run verify:staging-e2e`) verifies API readiness (strictly refusing production `STAGING_BASE_URL` hostnames or `sk_live_` keys), isolated merchant registration/workspace creation, initial Free Audit state, Shopify OAuth connect initiation, Checkout Session creation, negative webhook/HMAC/invalid-tier/unauthenticated/cross-tenant isolation checks, transactional password-reset SMTP triggering (including non-enumeration), and deterministic cleanup (expiring `cs_test_` Checkout Sessions, deleting test accounts via `DELETE /api/auth/account`, and verifying post-delete `/api/auth/me` + `/api/auth/login` 401 rejections).

Interactive browser completion in staging verifies the remaining hosted-UI redirects and live inbox delivery:
1. Complete Shopify Admin OAuth consent in browser -> verify `/api/shopify/callback` stores encrypted token & redirects to Settings.
2. Trigger full catalog sync & verify Catalog Health audit score + saved evidence/audit snapshot.
3. Complete Stripe Test Checkout payment with test card `4242...` -> verify Checkout confirmation + webhook delivery -> verify paid subscription tier & unlocked reports/SKU limits.
4. Exercise negative scenarios: duplicate webhooks (`duplicate` idempotent handling), invalid Stripe signature (`400`/`401`), invalid Shopify HMAC (`401`), expired/replayed OAuth state (`400`), wrong-plan Price ID rejection, failed payment (`4000...0002` -> `past_due` capacity restriction), subscription cancellation -> downgrade to `Free Audit` preserving products, cross-tenant isolation, unauthenticated access (`401`), and disconnected Shopify handling.
5. Check transactional email delivery for both `POST /api/auth/forgot-password` and the 5 billing lifecycle events (`initial_payment_confirmed`, `recurring_renewal`, `plan_changed`, `payment_failed`, `subscription_canceled`) in the target inbox (`SMTP_TEST_RECIPIENT`), and inspect `GET /api/billing/email-deliveries` to verify workspace-scoped delivery records without duplicate sends or secret leakage.

### Execution & Cleanup
```bash
npm run verify:staging-e2e
```
After completion, reset or purge staging test workspaces (`Staging Verify *`), disconnect the test store installation, cancel Stripe Test Mode subscriptions/customers, and re-run `npm run verify:commercial:report -- --write` to capture final evidence.
