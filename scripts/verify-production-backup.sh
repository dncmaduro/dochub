#!/usr/bin/env bash
set -euo pipefail
backup_env=${BACKUP_ENV:-/srv/dochub/.backup.env}
usage() { echo "Usage: $0 [--full]"; }
[[ ${1:-} == --help ]] && { usage; exit 0; }; [[ ${1:-} == "" || ${1:-} == --full ]] || { usage >&2; exit 2; }
command -v restic >/dev/null || { echo 'verify: ERROR: restic is required but was not found' >&2; exit 1; }
command -v jq >/dev/null || { echo 'verify: missing dependency: jq' >&2; exit 1; }
[[ -f $backup_env && $(stat -c '%a' "$backup_env" 2>/dev/null || true) == 600 ]] || { echo 'verify: protected backup environment is required' >&2; exit 1; }
set -a; source "$backup_env"; set +a
case "${RESTIC_REPOSITORY:-}" in ''|/srv/*|/var/*|/home/*|/tmp/*|file:*|local:*) echo 'verify: repository is not offsite' >&2; exit 1 ;; esac
json=$(restic snapshots --tag dochub-production --latest 1 --json); snapshot=$(jq -r '.[0].short_id // empty' <<<"$json"); timestamp=$(jq -r '.[0].time // empty' <<<"$json")
[[ -n $snapshot && -n $timestamp ]] || { echo 'verify: no production snapshot found' >&2; exit 1; }
age=$(( $(date -u +%s) - $(date -u -d "$timestamp" +%s) )); (( age >= 0 && age <= ${BACKUP_MAX_AGE_HOURS:-30} * 3600 )) || { echo "verify: snapshot $snapshot is too old" >&2; exit 1; }
listing=$(restic ls "$snapshot"); grep -q 'manifest.txt' <<<"$listing" && grep -q 'postgres.dump' <<<"$listing" && grep -q '/storage/' <<<"$listing" || { echo 'verify: snapshot lacks manifest, dump, or storage' >&2; exit 1; }
[[ ${1:-} != --full ]] || restic check
echo "verify: snapshot $snapshot is healthy; age ${age}s"
