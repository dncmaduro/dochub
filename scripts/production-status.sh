#!/usr/bin/env bash
set -euo pipefail
app_root=${APP_ROOT:-/srv/dochub/app}; prod_env=${PROD_ENV:-/srv/dochub/.env.production}; backup_env=${BACKUP_ENV:-/srv/dochub/.backup.env}
[[ ${1:-} == --help ]] && { echo "Usage: $0"; exit 0; }
[[ -f $prod_env ]] || { echo 'status: production environment missing' >&2; exit 1; }; set -a; source "$prod_env"; set +a
compose=(docker compose --env-file "$prod_env" -f "$app_root/docker-compose.prod.yml")
echo "git_sha=$(git -c safe.directory="$app_root" -C "$app_root" rev-parse HEAD 2>/dev/null || echo unknown)"; "${compose[@]}" ps
curl --fail --silent --show-error --max-time 15 "https://${WEB_HOST}/api/health" >/dev/null && echo 'public_health=ok' || echo 'public_health=failed'
df -h /; free -h 2>/dev/null || vm_stat 2>/dev/null || true; docker system df || true
du -sh "$DOCHUB_STORAGE_HOST_PATH" "${POSTGRES_DATA_HOST_PATH:-}" 2>/dev/null || true
if [[ ! -f $backup_env ]]; then
  echo 'backup=not_configured'
elif ! command -v restic >/dev/null; then
  echo 'backup=not_configured (restic is not installed)'
else
  set -a; source "$backup_env"; set +a
  restic snapshots --tag dochub-production --latest 1 2>/dev/null || echo 'backup=unavailable_or_no_snapshot'
fi
"${compose[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc 'SELECT max("finished_at") FROM "_prisma_migrations";' 2>/dev/null || true
command -v openssl >/dev/null && echo | openssl s_client -connect "${WEB_HOST}:443" -servername "$WEB_HOST" 2>/dev/null | openssl x509 -noout -enddate || true
