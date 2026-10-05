#!/usr/bin/env bash
# Creates an encrypted, offsite restic snapshot. Run only on the production host.
set -euo pipefail
app_root=${APP_ROOT:-/srv/dochub/app}; prod_env=${PROD_ENV:-/srv/dochub/.env.production}
backup_env=${BACKUP_ENV:-/srv/dochub/.backup.env}; lock_file=${BACKUP_LOCK_FILE:-/srv/dochub/backup.lock}
compose=(docker compose --env-file "$prod_env" -f "$app_root/docker-compose.prod.yml")
stopped=0; tmp_dir=''
usage() { echo "Usage: $0 [--prune]"; }
[[ ${1:-} == --help ]] && { usage; exit 0; }; [[ ${1:-} == "" || ${1:-} == --prune ]] || { usage >&2; exit 2; }
die() { echo "backup: $*" >&2; exit 1; }; note() { echo "backup: $*"; }
cleanup() {
  local status=$?
  if (( stopped )); then
    note 'restarting write-capable services'
    "${compose[@]}" start web api worker onlyoffice || status=1
    curl --fail --silent --show-error --max-time 30 "https://${WEB_HOST}/api/health" >/dev/null || { echo 'backup: public health failed after restart' >&2; status=1; }
  fi
  [[ -z $tmp_dir ]] || rm -rf -- "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT INT TERM
for command in docker flock sha256sum df curl; do command -v "$command" >/dev/null || die "missing dependency: $command"; done
command -v restic >/dev/null || die 'ERROR: restic is required but was not found'
[[ -f $prod_env && -f $backup_env ]] || die 'production or backup environment file is missing'
[[ $(stat -c '%a' "$backup_env" 2>/dev/null || true) == 600 ]] || die "$backup_env must have mode 600"
# Administrator-controlled dotenv files; never print their contents.
set -a; source "$prod_env"; source "$backup_env"; set +a
[[ -n ${RESTIC_REPOSITORY:-} && -r ${RESTIC_PASSWORD_FILE:-} ]] || die 'RESTIC_REPOSITORY and readable RESTIC_PASSWORD_FILE are required'
case "$RESTIC_REPOSITORY" in /srv/*|/var/*|/home/*|/tmp/*|file:*|local:*) die 'backup repository must be remote/offsite, not a VPS path' ;; esac
[[ -d ${DOCHUB_STORAGE_HOST_PATH:-} && -n ${POSTGRES_DB:-} && -n ${POSTGRES_USER:-} && -n ${WEB_HOST:-} ]] || die 'invalid production storage or database configuration'
exec 9>"$lock_file"; flock -n 9 || { echo 'backup: another backup is running' >&2; exit 75; }
tmp_dir=$(mktemp -d /srv/dochub/.backup-tmp.XXXXXX)
min_free_kb=${BACKUP_MIN_FREE_KB:-1048576}
[[ $min_free_kb =~ ^[0-9]+$ ]] || die 'BACKUP_MIN_FREE_KB must be a positive integer'
(( $(df -Pk "$tmp_dir" | awk 'NR==2 {print $4}') > min_free_kb )) || die "less than configured temporary-dump free-space minimum (${min_free_kb} KiB)"
note 'checking active EDIT sessions'
editor_close_grace=${ONLYOFFICE_EDIT_CLOSE_GRACE_SECONDS:-60}
[[ $editor_close_grace =~ ^[0-9]+$ ]] && (( editor_close_grace >= 15 && editor_close_grace <= 900 )) || die 'ONLYOFFICE_EDIT_CLOSE_GRACE_SECONDS must be between 15 and 900'
editor_callback_ttl=${ONLYOFFICE_CALLBACK_TOKEN_TTL_SECONDS:-3600}
[[ $editor_callback_ttl =~ ^[0-9]+$ ]] && (( editor_callback_ttl >= 60 && editor_callback_ttl <= 86400 )) || die 'ONLYOFFICE_CALLBACK_TOKEN_TTL_SECONDS must be between 60 and 86400'
active=$("${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM \"EditorSession\" WHERE \"status\" = 'ACTIVE' AND \"mode\" = 'EDIT' AND ((\"closedAt\" IS NULL AND \"createdAt\" > now() - interval '${editor_callback_ttl} seconds') OR (\"closedAt\" IS NOT NULL AND \"closedAt\" > now() - interval '${editor_close_grace} seconds')); ")
[[ $active =~ ^[0-9]+$ ]] || die 'could not inspect editor sessions'; (( active == 0 )) || { echo "backup: postponed: $active active EDIT session(s)" >&2; exit 75; }
note 'stopping write-capable services'; "${compose[@]}" stop web api worker onlyoffice; stopped=1
note 'creating PostgreSQL logical dump'; dump="$tmp_dir/postgres.dump"
"${compose[@]}" exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc >"$dump"
[[ -s $dump ]] || die 'pg_dump produced an empty dump'; dump_sha=$(sha256sum "$dump" | awk '{print $1}')
sha=$(git -c safe.directory="$app_root" -C "$app_root" rev-parse HEAD 2>/dev/null || echo unknown); migrations=$(find "$app_root/packages/database/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
{
  echo "backup_timestamp_utc=$(date -u +%FT%TZ)"; echo "backup_timestamp_local=$(date -Iseconds)"; echo "hostname=$(hostname)"; echo "git_sha=$sha"; echo "migration_count=$migrations"
  echo "postgres_version=$("${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc 'SHOW server_version;' | tr -d '[:space:]')"; echo "storage_path=$DOCHUB_STORAGE_HOST_PATH"; echo 'database_dump=postgres.dump'; echo "database_dump_sha256=$dump_sha"
  "${compose[@]}" images --format '{{.Service}} {{.Repository}}:{{.Tag}}' 2>/dev/null | sed 's/^/image=/' || true
  for table in User Node File FileVersion SearchDocument PermissionEntry; do echo "count_${table}=$("${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM \"$table\";" | tr -d '[:space:]')"; done
} >"$tmp_dir/manifest.txt"
note 'creating encrypted offsite snapshot'
restic backup --tag dochub-production --tag database --tag storage "$dump" "$DOCHUB_STORAGE_HOST_PATH" "$prod_env" "$tmp_dir/manifest.txt"
snapshot=$(restic snapshots --latest 1 --json | sed -n 's/.*"short_id":"\([^"]*\)".*/\1/p' | head -n1); [[ -n $snapshot ]] || die 'restic did not report a snapshot'; note "snapshot $snapshot created"
restic forget --tag dochub-production --keep-daily "${BACKUP_KEEP_DAILY:-7}" --keep-weekly "${BACKUP_KEEP_WEEKLY:-4}" --keep-monthly "${BACKUP_KEEP_MONTHLY:-6}"
if [[ ${1:-} == --prune || ${BACKUP_PRUNE:-0} == 1 ]]; then note 'pruning after successful snapshot'; restic prune; fi
note 'backup completed'
