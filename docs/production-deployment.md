# Docs Hub production deployment

Docs Hub is a single-VPS Docker Compose installation. This guide assumes that
the host already runs Nginx on ports 80 and 443; Docker must not publish either
public port.

## Topology

```text
Internet -> host Nginx TLS -> 127.0.0.1:$WEB_GATEWAY_PORT -> web -> api:3000
Internet -> host Nginx TLS -> 127.0.0.1:$ONLYOFFICE_GATEWAY_PORT -> onlyoffice:80

api, worker, onlyoffice -> postgres:5432 (internal Docker network)
worker                  -> tika:9998     (internal Docker network)
```

Only `web` and `onlyoffice` have host bindings, both explicitly loopback-only.
API, worker, PostgreSQL, Tika, storage, and uploads have no public route.
`ONLYOFFICE_INTERNAL_API_URL=http://api:3000` and `TIKA_URL=http://tika:9998`
use Docker service DNS; never use `host.docker.internal`.

## Persistent paths and environment

Keep application state outside the checkout:

```text
/srv/dochub/
  app/                 clean Git checkout
  storage/             document data
  uploads/             upload staging, separate from storage
  postgres/            PostgreSQL bind-mounted data directory
  .env.production      mode 0600, never committed
```

Copy `.env.production.example` to `/srv/dochub/.env.production`, replace all
placeholders, and use real host paths. The PostgreSQL service uses the durable
`POSTGRES_DATA_HOST_PATH` bind mount. Before its first start, an empty host
directory must be owned by the PostgreSQL image UID/GID; do not alter ownership
of a populated directory.

Set `WEB_ORIGIN=https://docshub.space`,
`GOOGLE_REDIRECT_URI=https://docshub.space/api/auth/google/callback`,
`AUTH_LOGIN_SUCCESS_REDIRECT_URL=https://docshub.space/auth/callback`, and
`ONLYOFFICE_PUBLIC_URL=https://office.docshub.space`. Register the Google
redirect URI exactly, while preserving development localhost URIs.

## Host Nginx and TLS

Host Nginx terminates TLS, redirects HTTP to HTTPS (except ACME), and proxies
the two names to their loopback ports. It must forward `Host`, `X-Real-IP`,
`X-Forwarded-For`, and `X-Forwarded-Proto`; the ONLYOFFICE host must also
forward websocket upgrade headers. Enable HSTS only after valid HTTPS is
working. Use the host Certbot renewal timer and obtain a certificate covering
both `docshub.space` and `office.docshub.space` without changing unrelated
virtual hosts or certificates.

## Deploy and rollback

Run only from a clean checkout at the intended commit:

```bash
cd /srv/dochub/app
./scripts/deploy-production.sh /srv/dochub/.env.production
```

The script validates Compose, builds images, waits for PostgreSQL, runs exactly
one `prisma migrate deploy`, starts the stack, and checks the loopback web
gateway. It never runs `migrate dev`, `db push`, reset, or volume removal.
There are **14** committed Prisma migrations.

For rollback, check out a known-good commit SHA, confirm a clean worktree, and
run the same script. Do not automatically reverse migrations; assess schema
compatibility and restore data only through a tested backup procedure.

## Capacity

The supplied defaults target a VPS with at least 6 GiB RAM: API 768 MiB,
worker 768 MiB, PostgreSQL 1 GiB, Tika 1 GiB, and ONLYOFFICE 2 GiB. Do not start
the full stack on a smaller host unless it has been workload-tested with a safe
capacity plan. Do not hide OOM pressure with broad system tuning.
