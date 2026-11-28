# AIXSHOP v1.0 — Commercial Integration Verification Evidence Template

Use this template to record verifiable evidence when executing commercial verification against real external targets. **Never convert a `BLOCKED`, mock, or local-loopback result into a `PASS`.**

---

## Run Metadata

- **Run ID:** `<e.g. cv_20261125_01>`
- **Simulated Artifact Run ID (`reports/simulated-test-results.json`):** `<e.g. sim_20261125_01 or NOT RUN>`
- **Simulated Suite SHA-256 Digests Verified (`sha256Verified=true` on all 4 suites):** `<Yes/No/NOT RUN>`
- **Date / Time (UTC):** `<YYYY-MM-DDTHH:MM:SSZ>`
- **Operator:** `<Name>`
- **Git Commit SHA:** `<SHA or "No git repo">`
- **Target Environment:** `<e.g. staging.aixshop.example.com>`
- **Production Denylist & Allowlist Confirmed (`PRODUCTION_HOSTS`/`PRODUCTION_APP_URL` exclude target; `STAGING_ALLOWED_HOSTS` matches exact staging host):** `<Yes/No>`
- **Command Executed:** `<exact command>`

---

## Summary Matrix

| Stage | Target | Overall Status (`PASS`/`FAIL`/`BLOCKED`/`NOT RUN`) | Notes |
| --- | --- | --- | --- |
| Stage 0: Config & Local/CI Checks | Local / Staging Config + PG | | |
| Stage 1: Shopify Development Store | `<shop>.myshopify.com` | | |
| Stage 2: Stripe Test Mode | `sk_test_...` / Stripe CLI | | |
| Stage 3: Real SMTP Provider | `<smtp-host:port>` | | |
| Stage 4: Staging End-to-End Journey | `<STAGING_BASE_URL>` | | |

---

## Stage 1 Evidence — Shopify Development Store

- **Status:** `<PASS | FAIL | BLOCKED | NOT RUN>`
- **Dev Store Domain:** `<store.myshopify.com>`
- **Command:** `npm run verify:shopify`
- **Evidence IDs / Observed Outputs:**
  - OAuth authorize URL host & state validation: `<result>`
  - Callback HMAC verification & replay rejection: `<result>`
  - Admin GraphQL shop query response (`myshopifyDomain`, `currencyCode`): `<result>`
  - Paginated product read (`pagesFetched`, `uniqueProductsObserved`, `duplicateCount=0`, `terminatedCleanly`): `<result>`
  - Registered webhook topics & callback URL match (`S1-WEBHOOK-SUBSCRIPTIONS`): `<result>`
  - Local webhook HMAC simulation (`S1-WEBHOOK-HMAC-SIMULATION` — `PASS — SIMULATED` only): `<result>`
  - Real deployed Shopify webhook delivery (`S1-WEBHOOK-LIVE-DELIVERY` — `NOT RUN` unless delivered): `<result>`
  - Cleanup confirmed (temporary `AIXSHOP-VERIFY-*` `productDelete` + follow-up `null` read): `<Yes/No/N/A>`

---

## Stage 2 Evidence — Stripe Test Mode

- **Status:** `<PASS | FAIL | BLOCKED | NOT RUN>`
- **Mode Guard Confirmed (`sk_test_` only, `sk_live_` rejected):** `<Yes/No>`
- **Command:** `npm run verify:stripe`
- **Evidence IDs / Observed Outputs:**
  - Active Price IDs verified (`Starter`=$49, `Growth`=$149, `Enterprise`=$499): `<price_... IDs>`
  - Test Checkout Sessions verified (`Starter` & `Growth` `cs_test_...`, customer, metadata, `checkout.stripe.com` URL): `<ids>`
  - Local Webhook Simulation (`S2-WEBHOOK-LOCAL-SIMULATION` — `PASS — SIMULATED` only): `<result>`
  - Real Deployed Stripe Webhook Delivery (`S2-WEBHOOK-LIVE-DELIVERY` — `NOT RUN` unless delivered): `<evt_... / NOT RUN>`
  - Test Clock ID (if enabled), `testClocks.advance()` & renewal invoice + lifecycle transitions: `<clock_... / NOT RUN>`
  - Cleanup confirmed (`S2-STRIPE-CLEANUP`: sessions expired, customers & test clocks deleted): `<Yes/No>`

---

## Stage 3 Evidence — Real SMTP Provider

- **Status:** `<PASS | FAIL | BLOCKED | NOT RUN>`
- **SMTP Host / Port / TLS Mode:** `<host:port (STARTTLS/SMTPS)>`
- **Command:** `npm run verify:smtp`
- **Evidence IDs / Observed Outputs:**
  - `smtp_configuration_valid`: `<true/false>`
  - `smtp_connection_verified`: `<true/false>`
  - `smtp_message_accepted`: `<true/false>`
  - Returned `Message-ID`: `<messageId>`
  - `inbox_delivery_confirmed`: `<false until confirmed in recipient inbox/provider dashboard>`
  - Manual Inbox Receipt Confirmation (timestamp & screenshot/log ref): `<Pending / Confirmed at YYYY-MM-DD>`

---

## Stage 4 Evidence — Staging End-to-End Customer Journey

- **Status:** `<PASS | FAIL | BLOCKED | NOT RUN>`
- **Staging URL:** `<https://...>`
- **Command:** `npm run verify:staging-e2e`
- **20-Step Customer Journey Check:**
  - Account registration & isolated workspace creation: `<PASS/FAIL/BLOCKED>`
  - Initial `Free Audit` state & paywall enforcement: `<PASS/FAIL/BLOCKED>`
  - Shopify Dev Store OAuth connect & product sync + pagination: `<PASS/FAIL/BLOCKED>`
  - Catalog Health Audit & saved evidence snapshot: `<PASS/FAIL/BLOCKED>`
  - Stripe Test Checkout + Webhook + Subscription upgrade & report unlock: `<PASS/FAIL/BLOCKED>`
  - Staging SMTP transactional trigger (`POST /api/auth/forgot-password`): `<PASS/FAIL/BLOCKED>`
- **11 Negative Scenarios Verified:**
  1. Duplicate webhooks (Shopify & Stripe): `< >`
  2. Invalid Stripe webhook signature: `< >`
  3. Invalid Shopify webhook HMAC: `< >`
  4. Expired/replayed OAuth state: `< >`
  5. Wrong-plan / tampered tier checkout rejection: `< >`
  6. Failed payment (`past_due` fail-closed capacity restriction): `< >`
  7. Subscription cancellation (`Free Audit` downgrade preserving products): `< >`
  8. Wrong-tenant / cross-workspace access rejection: `< >`
  9. Unauthenticated protected route rejection (`401`): `< >`
  10. Disconnected Shopify store behavior: `< >`
  11. Failed SMTP delivery (non-enumeration + no leaked secrets): `< >`
- **Staging Cleanup Confirmed (test accounts deleted, `/api/auth/me` & `/api/auth/login` 401 verified, `cs_test_` sessions expired):** `<Yes/No>`
