#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v python3 >/dev/null || { echo 'Python 3 is required.' >&2; exit 1; }
if [[ ${1:-} == --help ]]; then
  exec python3 scripts/init_env.py --help
fi
if [[ -e .env || -L .env ]]; then
  echo 'Existing .env preserved. Use scripts/deploy.sh with the configured local URL.' >&2
  exit 1
fi
command -v docker >/dev/null || { echo 'Docker Engine and Compose v2 must be installed first.' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null
existing_containers=$(docker ps -aq --filter label=com.docker.compose.project=twinnku)
existing_volumes=$(docker volume ls -q --filter label=com.docker.compose.project=twinnku)
if [[ -n $existing_containers || -n $existing_volumes ]] || docker volume inspect twinnku_pgdata >/dev/null 2>&1; then
  echo 'An existing Twin NKU installation or database was found. Restore its original .env; first-run will not change it.' >&2
  exit 1
fi
base_url=$(python3 scripts/init_env.py "$@")
echo 'Private server configuration created. Building the foundation application.'
bash scripts/deploy.sh "$base_url"
