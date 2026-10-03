#!/usr/bin/env bash
set -euo pipefail

# A deliberate single-VPS deployment sequence. It never resets a database,
# removes volumes, or prints environment values.
root_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${1:-"$root_dir/.env.production"}

if [[ ! -f "$env_file" ]]; then
  echo "Production environment file not found: $env_file" >&2
  exit 1
fi

required_keys=(
  WEB_HOST ONLYOFFICE_HOST WEB_ORIGIN DATABASE_URL POSTGRES_PASSWORD
  AUTH_ACCESS_TOKEN_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
  GOOGLE_REDIRECT_URI AUTH_LOGIN_SUCCESS_REDIRECT_URL
  ONLYOFFICE_PUBLIC_URL ONLYOFFICE_INTERNAL_API_URL ONLYOFFICE_JWT_SECRET
  ONLYOFFICE_FETCH_TOKEN_SECRET DOCHUB_STORAGE_HOST_PATH
  DOCHUB_UPLOAD_TEMP_HOST_PATH POSTGRES_DATA_HOST_PATH LETSENCRYPT_HOST_PATH
  CERTBOT_WEBROOT_HOST_PATH
)
for key in "${required_keys[@]}"; do
  if ! grep -qE "^${key}=.+" "$env_file"; then
    echo "Missing required production configuration: $key" >&2
    exit 1
  fi
done
if grep -qiE '=("?)(replace-with|change-this|development-only)' "$env_file"; then
  echo "Production environment file still contains a placeholder value" >&2
  exit 1
fi

cd "$root_dir"
export DOCHUB_ENV_FILE="$env_file"
compose=(docker compose --env-file "$env_file" -f docker-compose.prod.yml)

"${compose[@]}" config -q
"${compose[@]}" build api worker web migrate
"${compose[@]}" up -d --wait postgres
"${compose[@]}" --profile migration run --rm migrate
"${compose[@]}" up -d --wait --remove-orphans

# This checks the public TLS proxy locally without exposing a health route.
web_host=$(sed -n 's/^WEB_HOST=//p' "$env_file" | head -n 1)
curl --fail --silent --show-error --resolve "$web_host:443:127.0.0.1" \
  "https://$web_host/api/health" >/dev/null
echo "Deployment completed; API readiness check passed."
