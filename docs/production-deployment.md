# Docs Hub production deployment

Docs Hub deploys one single-VPS installation with Docker Compose. It is not a
multi-instance or zero-downtime topology. Read [SECURITY.md](../SECURITY.md)
before operating it.

## Topology and URL model

`web` is the only service publishing host ports. It terminates TLS, serves the
Vite build, proxies the public API route, and proxies the public ONLYOFFICE
hostname.

```text
Internet -> https://WEB_HOST/             -> web (static SPA)
         -> https://WEB_HOST/api/*         -> web -> api:3000
         -> https://ONLYOFFICE_HOST/       -> web -> onlyoffice:80

api, worker, onlyoffice -> postgres:5432   (private backend network)
worker                  -> tika:9998       (private backend network)
onlyoffice              -> api:3000        (private backend network)
api/worker              -> VPS bind mounts (document storage)
```

The browser API base is built as `/api`, avoiding a hard-coded domain. Set
`WEB_ORIGIN=https://WEB_HOST`. `ONLYOFFICE_PUBLIC_URL` is browser-facing HTTPS;
`ONLYOFFICE_INTERNAL_API_URL=http://api:3000` is only for Document Server to
fetch signed content and submit callbacks. Do not exchange them. Production does
not use `localhost` or `host.docker.internal` for service-to-service traffic.

The `proxy` network has `web`, `api`, and `onlyoffice`. The internal `backend`
network has `api`, `worker`, `onlyoffice`, `postgres`, and `tika`. PostgreSQL,
Tika, API, worker, and ONLYOFFICE publish no host port. Nginx never mounts or
serves storage. Redis is excluded: there are no Redis imports or runtime uses;
the in-memory limiter is intended for this one API instance.

## Prerequisites and storage

Install Docker Engine and Compose v2. Configure DNS A/AAAA records for both
hostnames. Copy this checkout and the untracked production environment file to
`/srv/dochub` (or equivalent):

```text
/srv/dochub/
  .env.production              mode 0600, untracked
  storage/                     owned by UID:GID 1000:1000, mode 0750
  tmp/uploads/                 owned by UID:GID 1000:1000, mode 0750
  postgres/                    persistent PostgreSQL data
  letsencrypt/                 certificate material, never committed
  certbot-webroot/             ACME HTTP-01 challenge files
```

The API and worker run as Node UID 1000. The API gets `/data/storage` and
`/data/uploads`; the worker gets only `/data/storage` because it reads for Tika
and deletes expired content but never needs upload staging. ONLYOFFICE, Tika,
PostgreSQL, and Nginx get neither mount. Production storage and staging should
remain separate sibling roots; the API rejects equal roots at startup.

Copy `.env.production.example` to `.env.production`, replace all placeholders,
and keep it out of Git. It labels required host paths, URLs, PostgreSQL,
authentication/OIDC, storage, ONLYOFFICE, and Tika settings, plus optional
resource/image tuning. Production validates `NODE_ENV`, HTTPS origins, secure
cookies, Google OIDC as a complete group, PostgreSQL URL, storage roots, and
non-placeholder 32+-character secrets. URL-encode reserved password characters
in `DATABASE_URL`, while preserving the raw value in `POSTGRES_PASSWORD`.

## TLS

HTTP redirects to HTTPS except for `/.well-known/acme-challenge/`. Nginx reads
a read-only certificate from `/etc/letsencrypt/live/$WEB_HOST`; it must be a SAN
certificate covering both public names. HSTS is emitted only from HTTPS virtual
hosts. For first issuance, after DNS is live and port 80 is free:

```bash
docker run --rm -p 80:80 \
  -v /srv/dochub/letsencrypt:/etc/letsencrypt \
  certbot/certbot:v2.11.0 certonly --standalone \
  -d docs.example.com -d office.docs.example.com
```

Use configured names, not the examples. With the stack running, renew through
the webroot and reload Nginx:

```bash
docker run --rm \
  -v /srv/dochub/letsencrypt:/etc/letsencrypt \
  -v /srv/dochub/certbot-webroot:/var/www/certbot \
  certbot/certbot:v2.11.0 renew --webroot -w /var/www/certbot
docker compose --env-file .env.production -f docker-compose.prod.yml exec web nginx -s reload
```

Schedule renewal (for example twice daily); Certbot renews only when needed. A
VPS-managed certificate is fine if it is mounted in the same read-only layout.

## Deploy, migrate, and rollback

```bash
cp .env.production.example .env.production
chmod 600 .env.production
mkdir -p /srv/dochub/{storage,tmp/uploads,postgres,letsencrypt,certbot-webroot}
sudo chown -R 1000:1000 /srv/dochub/storage /srv/dochub/tmp
./scripts/deploy-production.sh /srv/dochub/.env.production
```

The script checks required values without printing them, validates Compose,
builds images, waits for PostgreSQL, runs one `prisma migrate deploy`, starts
the long-running services, then checks TLS `/api/health`. A migration failure
aborts before API/worker restart. It never runs `migrate dev`, resets a schema,
deletes storage, or removes data. There are **14** checked-in migrations:

```bash
pnpm --filter @dochub/database exec prisma migrate status
```

Single-instance restarts cause a short maintenance interruption. Before upgrade:
verify backups, review migration SQL, build/pull an immutable image tag, migrate,
restart, health-check, and smoke-test. Keep the old tag. To roll back an
application/config error, restore the previous tag/config and restart. Do not
automatically reverse database migrations; assess compatibility and use a tested
database backup for schema/data restoration when required.

## Operations

`GET /health` is API readiness: it proves Nest can query PostgreSQL and returns
503 if it cannot. It deliberately does not depend on Tika/ONLYOFFICE. Docker
healthchecks also observe PostgreSQL, Document Server, Tika, web, and API.
Observe worker work and restart count through `docker compose ... logs worker`;
its CP32B leases recover after restart. A Document Server restart can end an
open edit session, while a Tika restart causes transient jobs to retry.

Logs go only to stdout/stderr. Use `docker compose --env-file .env.production
-f docker-compose.prod.yml logs -f api worker` and configure Docker daemon log
rotation (for example `max-size: 10m`, `max-file: 5`). Do not log tokens,
cookies, callback queries, secrets, or document content.

Defaults suit at least 6 GB RAM: API 768 MB, worker 768 MB, PostgreSQL 1 GB,
Tika 1 GB, and ONLYOFFICE 2 GB. They are configurable, but document services
must be workload-tested before limits are reduced. `restart: unless-stopped`
returns services after reboot; enable Docker at boot. Firewall policy: 80/443
and administration SSH only—never publish database, Tika, API, Redis, worker,
or Document Server ports.

After deploy validate `/`, `/drive`, refreshing `/drive/:nodeId`, `/search`,
`/recent`, `/favorites`, `/trash`, and `/auth/callback`; then test API health,
upload/download, byte ranges/PDF/video streaming, Tika extraction, and
ONLYOFFICE VIEW/EDIT with a real account. Verify Document Server fetch/callback
over Docker DNS and confirm raw storage has no public route. Real Google OAuth
requires the configured public callback and cannot be fully proven locally.
