# AIXSHOP v1.0 — Commercial Integration Verification Playbook

This guide documents how to prepare, execute, record evidence for, and clean up the four external commercial integration verification stages for **AIXSHOP v1.0**.

> **Truthfulness Policy:** Unit tests, mocked contract suites, and local loopback responders verify internal code correctness only (`[CONTRACT / SIMULATED]`). Real external verification requires `COMMERCIAL_VERIFY_EXTERNAL=true` plus genuine external credentials/targets. Missing credentials always report `BLOCKED` — never `PASS`.

---

## Status Model

| Status | Meaning |
| --- | --- |
| `PASS` | Executed against the intended real target with verifiable evidence |
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
  - Aggregate JSON/Markdown report: `npm run verify:commercial:report -- --write`

Add `--strict` to any `verify:*` command to exit non-zero (`2`) if any check is `BLOCKED` (useful as a pre-release gate).

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
- By default, `verify:shopify` runs read-only GraphQL catalog pagination (`pageSize=5`), OAuth state/HMAC checks, and webhook subscription inspection without mutating store products.
- If `SHOPIFY_ALLOW_TEST_PRODUCT_MUTATION=true`, it creates one `DRAFT` product prefixed `AIXSHOP-VERIFY-` and deletes it inside a `finally` block.
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
- Optional: `STRIPE_TEST_CUSTOMER_EMAIL`, `STRIPE_TEST_CLOCK_ENABLED="true"` (exercises real Stripe Test Clock plan upgrades, `cancel_at_period_end`, and immediate cancellation)

### Execution & Test Cards
```bash
npm run verify:stripe
```
For interactive Stripe Checkout testing in Stage 4:
- Successful payment: `4242 4242 4242 4242` (any future expiry/CVC)
- Declined / failed payment: `4000 0000 0000 0002` (or `pm_card_chargeDeclined` in API tests)

### Cleanup
- `verify:stripe` expires temporary Checkout Sessions, deletes temporary Test Customers (`aixshop_verification=true`), and deletes created Test Clocks in a `finally` block.
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

---

## Stage 4 — Staging End-to-End Customer Journey

### Prerequisites & Safety Guardrails
1. Deploy AIXSHOP to an **isolated staging environment** (`STAGING_BASE_URL`, HTTPS) connected to a **staging PostgreSQL database** (migrations `001`–`018` applied).
2. Set `STAGING_CONFIRM_NON_PRODUCTION="true"` and configure Shopify Dev Store, Stripe Test Mode (`sk_test_...`), and Real SMTP env vars on both the staging deployment and verification runner.
3. Never point `STAGING_BASE_URL` at production or supply a live Stripe key.

### 20-Step Customer Journey & 11 Negative Scenarios
Automated runner (`npm run verify:staging-e2e`) verifies API readiness, isolated merchant registration/workspace creation, initial Free Audit state, Shopify OAuth connect initiation, Checkout Session creation, negative webhook/HMAC/unauthenticated/cross-tenant isolation checks, and transactional password-reset SMTP triggering.

Interactive browser completion in staging verifies the remaining hosted-UI redirects:
1. Complete Shopify Admin OAuth consent in browser -> verify `/api/shopify/callback` stores encrypted token & redirects to Settings.
2. Trigger full catalog sync & verify Catalog Health audit score + saved evidence/audit snapshot.
3. Complete Stripe Test Checkout payment with test card `4242...` -> verify webhook delivery -> verify paid subscription tier & unlocked reports/SKU limits.
4. Exercise negative scenarios: duplicate webhooks (`duplicate` idempotent handling), invalid Stripe signature (`400`/`401`), invalid Shopify HMAC (`401`), expired/replayed OAuth state (`400`), wrong-plan Price ID rejection, failed payment (`4000...0002` -> `past_due` capacity restriction), subscription cancellation -> downgrade to `Free Audit` preserving products, cross-tenant isolation, unauthenticated access (`401`), and disconnected Shopify handling.
5. Check transactional email delivery for `POST /api/auth/forgot-password` in the target inbox (`SMTP_TEST_RECIPIENT`). Note: AIXSHOP v1.0 triggers real transactional emails for password reset; checkout confirmation emails are not currently emitted by `billingRoutes`/`billingService`.

### Execution & Cleanup
```bash
npm run verify:staging-e2e
```
After completion, reset or purge staging test workspaces (`Staging Verify *`), disconnect the test store installation, cancel Stripe Test Mode subscriptions/customers, and re-run `npm run verify:commercial:report -- --write` to capture final evidence.
