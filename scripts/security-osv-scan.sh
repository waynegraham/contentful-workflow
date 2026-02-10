#!/usr/bin/env bash
set -euo pipefail

REPORT_PATH="${1:-reports/osv-report.json}"
LOCKFILE="${LOCKFILE:-package-lock.json}"

if ! command -v osv-scanner >/dev/null 2>&1; then
  echo "osv-scanner is not installed. Install it first: https://google.github.io/osv-scanner/installation/" >&2
  exit 1
fi

mkdir -p "$(dirname "$REPORT_PATH")"
osv-scanner scan source --lockfile "$LOCKFILE" --format json --output "$REPORT_PATH"

echo "OSV report written to: $REPORT_PATH"
