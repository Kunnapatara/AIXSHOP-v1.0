#!/usr/bin/env bash
set -euo pipefail

# AIXSHOP v1.0 — Scratch-Only PostgreSQL Restore Verification Drill
# NEVER runs against production or primary DATABASE_URL.
# Usage:
#   CONFIRM_SCRATCH_RESTORE=true SCRATCH_DATABASE_URL="postgresql://.../aixshop_scratch_restore" \
#     ./scripts/ops/restore-verify-postgres.sh /path/to/aixshop_backup.dump

DUMP_FILE="${1:-}"

if [ -z "$DUMP_FILE" ] || [ ! -f "$DUMP_FILE" ]; then
  echo "[ERROR] Valid .dump artifact path is required as argument 1." >&2
  exit 1
fi

if [ "${NODE_ENV:-}" = "production" ]; then
  echo "[SAFETY REFUSAL] Cannot run restore drill when NODE_ENV=production." >&2
  exit 1
fi

if [ "${CONFIRM_SCRATCH_RESTORE:-}" != "true" ]; then
  echo "[SAFETY REFUSAL] Set CONFIRM_SCRATCH_RESTORE=true to acknowledge restoring into an isolated scratch DB." >&2
  exit 1
fi

if [ -z "${SCRATCH_DATABASE_URL:-}" ]; then
  echo "[SAFETY REFUSAL] SCRATCH_DATABASE_URL must be explicitly set." >&2
  exit 1
fi

if [ -n "${DATABASE_URL:-}" ] && [ "${SCRATCH_DATABASE_URL}" = "${DATABASE_URL}" ]; then
  echo "[SAFETY REFUSAL] SCRATCH_DATABASE_URL must NOT equal DATABASE_URL." >&2
  exit 1
fi

LOWER_SCRATCH="$(printf '%s' "$SCRATCH_DATABASE_URL" | tr '[:upper:]' '[:lower:]')"
if printf '%s' "$LOWER_SCRATCH" | grep -qE '(^|[/:@_-])(prod|production|live|primary)([/:@._?-]|$)'; then
  echo "[SAFETY REFUSAL] SCRATCH_DATABASE_URL appears to reference a production/live database. Aborting." >&2
  exit 1
fi

if ! printf '%s' "$LOWER_SCRATCH" | grep -qE '(scratch|restore_verify|drill|test)'; then
  echo "[SAFETY REFUSAL] SCRATCH_DATABASE_URL database name must include scratch, restore_verify, drill, or test." >&2
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
  echo "[ERROR] pg_restore and psql are required in this environment. Status: BLOCKED." >&2
  exit 2
fi

SHA_FILE="${DUMP_FILE}.sha256"
if [ -f "$SHA_FILE" ]; then
  echo "[AIXSHOP Restore Verify] Verifying SHA-256 checksum..."
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$SHA_FILE"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "$SHA_FILE"
  fi
fi

echo "[AIXSHOP Restore Verify] Restoring dump into isolated scratch database..."
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --dbname="$SCRATCH_DATABASE_URL" \
  "$DUMP_FILE"

echo "[AIXSHOP Restore Verify] Checking schema_migrations and core table integrity..."
psql "$SCRATCH_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT COUNT(*) AS migration_count FROM schema_migrations;
SELECT filename FROM schema_migrations WHERE filename = '019_writeback_and_billing_emails.sql';
SELECT
  (SELECT COUNT(*) FROM workspaces) AS workspaces_count,
  (SELECT COUNT(*) FROM stores) AS stores_count,
  (SELECT COUNT(*) FROM subscriptions) AS subscriptions_count,
  (SELECT COUNT(*) FROM billing_email_deliveries) AS billing_email_deliveries_count,
  (SELECT COUNT(*) FROM shopify_connections) AS shopify_connections_count;
SQL

echo "[AIXSHOP Restore Verify] Scratch restore verification PASSED."
