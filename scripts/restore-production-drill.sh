#!/usr/bin/env bash
# Never restores live production. It uses a disposable PostgreSQL container.
set -euo pipefail
backup_env=${BACKUP_ENV:-/srv/dochub/.backup.env}; drill_base=${RESTORE_DRILL_ROOT:-/srv/dochub/restore-drills}; snapshot=''
usage() { echo "Usage: $0 --snapshot SNAPSHOT [--drill-root PATH]"; }
while (( $# )); do case "$1" in --snapshot) snapshot=${2:-}; shift 2;; --drill-root) drill_base=${2:-}; shift 2;; --help) usage; exit 0;; *) usage >&2; exit 2;; esac; done
[[ -n $snapshot ]] || { usage >&2; exit 2; }
command -v restic >/dev/null || { echo 'restore-drill: ERROR: restic is required but was not found' >&2; exit 1; }
for command in docker sha256sum; do command -v "$command" >/dev/null || { echo "restore-drill: missing dependency: $command" >&2; exit 1; }; done
[[ -f $backup_env ]] || { echo 'restore-drill: backup environment missing' >&2; exit 1; }; set -a; source "$backup_env"; set +a
case "${RESTIC_REPOSITORY:-}" in ''|/srv/*|/var/*|/home/*|/tmp/*|file:*|local:*) echo 'restore-drill: repository is not offsite' >&2; exit 1 ;; esac
case "$drill_base" in /srv/dochub/storage*|/srv/dochub/postgres*) echo 'restore-drill: drill root overlaps live data' >&2; exit 1;; esac
mkdir -p "$drill_base"; drill=$(mktemp -d "$drill_base/drill.XXXXXX"); container="dochub-restore-drill-$$"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; echo "restore-drill: artifacts retained at $drill"' EXIT
restic restore "$snapshot" --target "$drill"
dump=$(find "$drill" -type f -name postgres.dump -print -quit); manifest=$(find "$drill" -type f -name manifest.txt -print -quit); storage=$(find "$drill" -type d -path '*/storage' -print -quit)
[[ -n $dump && -n $manifest && -n $storage ]] || { echo 'restore-drill: required content missing' >&2; exit 1; }
expected=$(sed -n 's/^database_dump_sha256=//p' "$manifest"); [[ -z $expected || $(sha256sum "$dump" | awk '{print $1}') == "$expected" ]] || { echo 'restore-drill: dump checksum mismatch' >&2; exit 1; }
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=restore-drill -e POSTGRES_DB=dochub_restore postgres:17.5-alpine >/dev/null
until docker exec "$container" pg_isready -U postgres -d dochub_restore >/dev/null 2>&1; do sleep 1; done
docker cp "$dump" "$container:/tmp/postgres.dump"; docker exec "$container" pg_restore -U postgres -d dochub_restore --exit-on-error /tmp/postgres.dump
for table in User Node File FileVersion SearchDocument PermissionEntry; do docker exec "$container" psql -U postgres -d dochub_restore -tAc "SELECT count(*) FROM \"$table\";" >/dev/null; done
failed=0
while IFS='|' read -r key checksum; do path="$storage/$key"; [[ -f $path ]] || { echo "restore-drill: missing $key" >&2; failed=1; continue; }; [[ -z $checksum || $(sha256sum "$path" | awk '{print $1}') == "$checksum" ]] || { echo "restore-drill: checksum mismatch $key" >&2; failed=1; }; done < <(docker exec "$container" psql -U postgres -d dochub_restore -At -F '|' -c 'SELECT "storageKey", "sha256" FROM "FileVersion";')
(( failed == 0 )) || exit 1
echo 'restore-drill: database, storage references, and checksums verified'
