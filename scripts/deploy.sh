#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env ]]; then
  echo 'Create .env from .env.example and configure the database password first.' >&2
  exit 1
fi
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo '.env must not be tracked by git.' >&2
  exit 1
fi
if [[ $(stat -c '%a' .env) != 600 ]]; then
  echo 'Run chmod 600 .env before deployment.' >&2
  exit 1
fi
docker compose version >/dev/null
docker compose config --quiet
docker compose build
# Re-run the one-shot migration on every release; never remove database volumes.
docker compose rm -f migrate
docker compose up -d --wait --wait-timeout 120
python3 scripts/smoke.py "${1:-http://127.0.0.1:8080}"
echo 'Local deployment passed smoke checks. Verify the external HTTPS URL separately.'
