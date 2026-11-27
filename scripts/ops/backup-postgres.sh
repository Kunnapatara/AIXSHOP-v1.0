#!/usr/bin/env bash
set -euo pipefail

# AIXSHOP v1.0 — Non-Destructive Logical PostgreSQL Backup Helper
# Usage:
#   DATABASE_URL="postgresql://..." ./scripts/ops/backup-postgres.sh [output_dir]

OUT_DIR="${1:-/tmp/aixshop_pg_backups}"

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[ERROR] pg_dump is not installed in this environment. Status: BLOCKED." >&2
  exit 2
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[ERROR] DATABASE_URL must be set to create a logical backup." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
DUMP_FILE="${OUT_DIR%/}/aixshop_backup_${STAMP}.dump"
SHA_FILE="${DUMP_FILE}.sha256"

echo "[AIXSHOP Backup] Starting pg_dump (custom compressed format) -> ${DUMP_FILE}"
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$DUMP_FILE" \
  "$DATABASE_URL"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$DUMP_FILE" > "$SHA_FILE"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$DUMP_FILE" > "$SHA_FILE"
fi

echo "[AIXSHOP Backup] Completed successfully."
echo "[AIXSHOP Backup] Artifact: ${DUMP_FILE}"
if [ -f "$SHA_FILE" ]; then
  echo "[AIXSHOP Backup] SHA-256: $(cut -d ' ' -f1 "$SHA_FILE")"
fi
