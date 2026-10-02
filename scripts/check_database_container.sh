#!/usr/bin/env bash
# Uses only newly named, isolated synthetic volumes; never existing application data.
set -euo pipefail
cd "$(dirname "$0")/.."
image=${1:?Supply the exact built database image to verify}
python3 - <<'PY'
import re
from pathlib import Path

compose = Path('compose.yaml').read_text(encoding='utf-8')
db = re.search(r'^  db:\n((?:^ {4}[^\n]*\n|^\n)+)', compose, re.MULTILINE)
if db is None or len(re.findall(r'^  db:$', compose, re.MULTILINE)) != 1:
    raise SystemExit('Compose must define one explicit database service')
body = db.group(1)
images = re.findall(r'^    image: (\S+)$', body, re.MULTILINE)
dockerfiles = re.findall(r'^      dockerfile: (\S+)$', body, re.MULTILINE)
if (
    len(images) != 1
    or re.fullmatch(r'twinnku-db:\$\{APP_VERSION:-[a-zA-Z0-9._-]+\}', images[0]) is None
    or dockerfiles != ['deploy/db.Dockerfile']
    or len(re.findall(r'^    build:', body, re.MULTILINE)) != 1
    or re.search(r'^    build:\n      context: \.\n      dockerfile: deploy/db\.Dockerfile$', body, re.MULTILINE) is None
):
    raise SystemExit('Compose database image/build must match the scanned database Dockerfile')
print('Compose database build and image match the scanned candidate')
PY
base=$(awk '$1 == "FROM" { print $2 }' deploy/db.Dockerfile)
[[ $base =~ ^postgres:17-alpine@sha256:[a-f0-9]{64}$ ]]
prefix="twinnku-db-smoke-$(cat /proc/sys/kernel/random/uuid)"
fresh="$prefix-fresh"
legacy="$prefix-legacy"
recovery="$prefix-recovery"
containers=("$fresh" "$legacy" "$recovery")
volumes=("$fresh-data" "$legacy-data" "$recovery-data")
cleanup() {
  docker rm -f -v "${containers[@]}" >/dev/null 2>&1 || true
  docker volume rm "${volumes[@]}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
export POSTGRES_PASSWORD
POSTGRES_PASSWORD=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')

docker run --rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint sh "$image" -ec '
    test "$(id -u):$(id -g)" = 70:70
    test ! -e /usr/local/bin/gosu
    ! command -v gosu
    test "$(stat -c %u:%g "$PGDATA")" = 70:70
    postgres --version | grep -Fx "postgres (PostgreSQL) 17.11"
  '

ready() {
  for _ in $(seq 1 60); do
    if docker exec "$1" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then return; fi
    if [[ $(docker inspect --format '{{.State.Running}}' "$1") != true ]]; then
      docker logs "$1"
      return 1
    fi
    sleep 1
  done
  docker logs "$1"
  return 1
}
start() {
  docker volume create "$1-data" >/dev/null
  docker run -d --name "$1" --network none --cap-drop ALL --security-opt no-new-privileges \
    --env POSTGRES_PASSWORD --mount "type=volume,src=$1-data,dst=/var/lib/postgresql/data" \
    "$image" >/dev/null
  ready "$1"
  docker exec "$1" sh -ec 'test "$(id -u):$(id -g)" = 70:70; test "$(stat -c %u:%g "$PGDATA")" = 70:70'
}
sql() {
  docker exec "$1" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -tAc "$2"
}
fixture() {
  sql "$1" "CREATE SCHEMA db_smoke; CREATE TABLE db_smoke.marker(value text NOT NULL); INSERT INTO db_smoke.marker VALUES ('$2');" >/dev/null
}

start "$fresh"
fixture "$fresh" fresh-kept
docker restart "$fresh" >/dev/null
ready "$fresh"
[[ $(sql "$fresh" 'SELECT value FROM db_smoke.marker') = fresh-kept ]]
printf '%s\n' 'Nonroot fresh volume, health and restart: passed'

# Produce an existing UID 70 database using the exact former official image's
# normal root-to-postgres entrypoint. Reuse that volume with the new image.
docker volume create "$legacy-data" >/dev/null
docker run -d --name "$legacy" --network none --env POSTGRES_PASSWORD \
  --mount "type=volume,src=$legacy-data,dst=/var/lib/postgresql/data" "$base" >/dev/null
ready "$legacy"
fixture "$legacy" legacy-kept
docker exec "$legacy" sh -ec 'test "$(stat -c %u:%g "$PGDATA")" = 70:70'
docker stop "$legacy" >/dev/null
docker rm "$legacy" >/dev/null
start "$legacy"
[[ $(sql "$legacy" 'SELECT value FROM db_smoke.marker') = legacy-kept ]]
printf '%s\n' 'Existing official UID 70 database: passed'

start "$recovery"
docker exec "$legacy" pg_dump -U postgres -d postgres --format=custom --schema=db_smoke \
  | docker exec -i "$recovery" pg_restore -U postgres -d postgres --exit-on-error \
      --single-transaction --no-owner --no-acl
[[ $(sql "$recovery" 'SELECT value FROM db_smoke.marker') = legacy-kept ]]
printf '%s\n' 'Private dump streamed to nonroot pg_restore: passed'
