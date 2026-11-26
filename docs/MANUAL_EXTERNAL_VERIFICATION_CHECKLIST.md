# AIXSHOP v1.0 — Manual External Provider & Browser Verification Checklist

> **Execution Note:** These checks require live external test credentials (Shopify Partners Development Store, Stripe Test Mode, Real SMTP Relay, PostgreSQL, and Staging HTTPS URL) configured exclusively via environment variables outside source control. Automated local verification must **never** claim `PASS — LIVE` for any item below until executed against the real external provider and signed off with evidence.

---

## Stage 1 — Shopify Development Store (Live OAuth, Sync, Webhooks & Write-Back)

- [ ] **1.1 App Installation & OAuth Grant**
  - Open **Settings → Connectors** in staging browser UI.
  - Enter `SHOPIFY_DEV_STORE_DOMAIN` (`*.myshopify.com`), test both read-only (`read_products`) and write-enabled (`read_products,write_products` via **Allow AIXSHOP to write back approved fixes** checkbox) OAuth consent in Shopify Partners Admin.
  - Confirm callback redirects cleanly to `/?page=settings&tab=connectors&shopify=connected` and **Write-Back Access** reports `read_products, write_products`.
- [ ] **1.2 Full Paginated GraphQL Sync**
  - Click **Sync Catalog Now** on a Dev Store containing multiple pages of products/variants.
  - Confirm `Products` view reports source classification **`Shopify OAuth Sync (Full Catalog)`** and zero missing/duplicate variants across pages.
- [ ] **1.3 Live Webhook Registration & Delivery**
  - Verify webhook subscriptions (`PRODUCTS_CREATE`, `PRODUCTS_UPDATE`, `PRODUCTS_DELETE`, `APP_UNINSTALLED`) show live-verified status.
  - Edit a test product in Shopify Admin UI and confirm the webhook updates the workspace catalog within seconds without duplicate processing.
- [ ] **1.4 Approved Write-Back & Shopify Admin Read-Back Verification**
  - On **Actions**, approve a variant barcode/price/title remediation action, then click **Write Back to Shopify**.
  - Confirm action status transitions to `applied_externally` and **Settings → Connectors → Recent Shopify Write-Back Operations** shows `verified_applied` with matching `Verified Value`.
  - Inspect the product directly in **Shopify Admin** and confirm the updated barcode/price/title is live in Shopify.
- [ ] **1.5 Token Security Check**
  - Confirm encrypted access token in PostgreSQL (`shopify_connections.access_token_encrypted`) is AES-256-GCM ciphertext and never appears in HTTP responses, browser network logs, or server console logs.

---

## Stage 2 — Stripe Test Mode (Checkout, Customer Portal, Subscriptions & Webhooks)

- [ ] **2.1 Paid Checkout Flow (`sk_test_...`)**
  - Starting on `Free Audit`, confirm `/api/audit/run`, `/api/audit/latest`, `/api/feed/validate`, and `/api/feed/export` return `403 REPORT_PAYMENT_REQUIRED` and paywall banners appear in the UI.
  - Click **Upgrade Plan** (Starter `$49/mo` or Growth `$149/mo`) and complete Stripe Hosted Checkout using Stripe Test card `4242 4242 4242 4242`.
  - Confirm return to staging verifies the Checkout Session and unlocks full audit, comparison, discovery, and feed export views.
- [ ] **2.2 Webhook Replay & Renewal**
  - Trigger `invoice.payment_succeeded` (`billing_reason=subscription_cycle`) via Stripe CLI (`stripe trigger invoice.payment_succeeded`) or Test Clock.
  - Confirm billing period advances and no duplicate webhook transitions occur on replay.
- [ ] **2.3 Customer Portal Plan Change & Cancellation**
  - Open **Manage Billing / Customer Portal**, switch tier (e.g., Starter → Growth) and test scheduled cancellation (`cancel_at_period_end`) as well as immediate cancellation.
  - Confirm workspace SKU limits and `Free Audit` downgrade behave accurately while retaining synced products.
- [ ] **2.4 Payment Failure Re-Lock (`past_due`)**
  - Simulate a failed invoice payment (`invoice.payment_failed`) in Stripe Test Mode.
  - Confirm workspace subscription transitions to `past_due` and immediately locks paid audit/export routes (`403 REPORT_PAYMENT_REQUIRED`).

---

## Stage 3 — Real SMTP Provider (Password Reset & Billing Lifecycle Emails)

- [ ] **3.1 Password Recovery Delivery (Inbox Receipt)**
  - Submit `POST /api/auth/forgot-password` from the login modal for a real test inbox.
  - Confirm **actual recipient inbox delivery** (not merely SMTP `250 OK`), click the `#reset_token=...` link, set a new password, and verify prior sessions are invalidated (`401`).
- [ ] **3.2 Billing Lifecycle Emails (Inbox Receipt & Deduplication)**
  - After Stage 2 checkout verification + webhook arrival, confirm **at most 1** *Payment Confirmed* email arrived in the recipient inbox.
  - Confirm *Subscription Renewal*, *Plan Updated*, *Payment Failed*, and *Subscription Canceled* emails arrive cleanly with accurate workspace name, plan tier, formatted currency/amount, billing period dates, support address, and **zero secret/token leakage**.
  - Verify `GET /api/billing/email-deliveries` records each delivery status without exposing raw recipient credentials or SMTP passwords.

---

## Stage 4 — Staging Browser & Multi-Tenant End-to-End Sign-Off

- [ ] **4.1 Automated Staging Runner**
  - Run `COMMERCIAL_VERIFY_EXTERNAL=true npm run verify:commercial:report -- --write` with staging + test credentials configured.
  - Inspect `docs/COMMERCIAL_VERIFICATION_REPORT.md` and confirm all 4 stages report `PASS` and `Cleanup Status: CLEANED`.
- [ ] **4.2 Public Store Discovery vs Full OAuth Sync Disclosure**
  - Test entering a public Shopify store URL in the guest landing analyzer and verify UI explicitly labels it **`Public Store Discovery — Limited Sample (25 products)`** alongside browser CORS limitations, distinct from **`Full Shopify Catalog Sync — Authenticated OAuth`**.
- [ ] **4.3 Final Staging Hygiene Check**
  - Confirm zero test workspaces, test users, or test Shopify mutations remain on staging after cleanup (`DELETE /api/auth/account`).
