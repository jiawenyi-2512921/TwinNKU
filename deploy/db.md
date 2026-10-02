# PostgreSQL container

`deploy/db.Dockerfile` keeps the exact official PostgreSQL 17.11 Alpine image,
PostgreSQL binaries, entrypoint and `/var/lib/postgresql/data` layout. It removes
only `/usr/local/bin/gosu` and starts directly as `postgres` (UID/GID 70).
The [official Alpine Dockerfile](https://github.com/docker-library/postgres/blob/master/17/alpine3.24/Dockerfile)
creates PGDATA with this owner; the
[official entrypoint](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh)
only invokes gosu and repairs ownership when started as UID 0. New named volumes
inherit the directory owner. Existing volumes must already belong to UID 70.

The removed gosu release was compiled with Go 1.24.6 and triggered the image
version scanner. This change removes that executable instead of suppressing CVEs
or changing the database version. The database also drops capabilities and cannot
gain new privileges. No Go compiler or replacement privilege helper is added.

Before replacing an existing database container, check its ownership using its
current container. This reads metadata without changing files:

```sh
docker compose exec -T db sh -ec '
  test "$(stat -c %u:%g "$PGDATA")" = 70:70
  test -z "$(find "$PGDATA" ! -user postgres -print -quit)"
'
```

If this fails, stop the rollout and inspect the ownership problem. Do not delete
the volume or automatically change its ownership. A restore recreates a database
by streaming the private dump into PostgreSQL, rather than copying physical data
files owned by a different user.

The security workflow builds the same database Dockerfile as Compose, runs
`scripts/check_database_container.sh` against isolated new volumes, then scans
the resulting image with the same Trivy HIGH/CRITICAL gate as API and web. The
smoke checks cover a fresh volume, health, restart, a database created with the
previous official image, and a custom-format dump restored through stdin. They
do not access production volumes or expose database ports.

Private recovery requires both `--image` and `--image-id` for an explicitly
selected, already built nonroot database image. Obtain its immutable ID with
`docker image inspect --format '{{.Id}}' twinnku-db:<release>`. The restore tool
checks the ID and configured user, then runs that ID; it never falls back to the
former official image or pulls a mutable tag.
