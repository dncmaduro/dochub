# Docs Hub production deployment

Docs Hub is a single-VPS Docker Compose installation. This guide assumes that
the host already runs Nginx on ports 80 and 443; Docker must not publish either
public port.

## Topology

```text
Internet -> host Nginx TLS -> 127.0.0.1:$WEB_GATEWAY_PORT -> web -> api:3000

api, worker -> postgres:5432 (internal Docker network)
worker      -> tika:9998     (internal Docker network)
```

Only `web` has a host binding, explicitly loopback-only. API, worker,
PostgreSQL, Tika, storage, and uploads have no public route. `TIKA_URL=http://tika:9998`
uses Docker service DNS; never use `host.docker.internal`.

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

Document share records use the immutable Node UUID at `/document/<uuid>`, but
that legacy editor URL now renders a safe unavailable state rather than
starting an editor. Drive-backed files should be opened from Docs Hub so their
Google `webViewLink` is used. Access is still resolved from the current ACL
and General Access setting for sharing APIs. The canonical URL migration
removes the legacy `ShareLink` table, so existing `/s/<token>` URLs stop
working; copy the document URL again from the Share dialog.

Set `WEB_ORIGIN=https://docshub.space`,
`GOOGLE_REDIRECT_URI=https://docshub.space/api/auth/google/callback`,
and `AUTH_LOGIN_SUCCESS_REDIRECT_URL=https://docshub.space/auth/callback`.
Register the Google redirect URI exactly, while preserving development
localhost URIs.

## Host Nginx and TLS

Host Nginx terminates TLS, redirects HTTP to HTTPS (except ACME), and proxies
`docshub.space` to the web loopback port. It must forward `Host`, `X-Real-IP`,
`X-Forwarded-For`, and `X-Forwarded-Proto`. Enable HSTS only after valid HTTPS
is working. Use the host Certbot renewal timer and keep the certificate scoped
to the Docs Hub hostname without changing unrelated virtual hosts or
certificates.

The deployment workflow updates the checkout and runs Docker Compose only; it
does not install, replace, test, reload, or remove host Nginx configuration.
After deploying the ONLYOFFICE removal, an operator must update the live host
configuration separately:

```bash
sudo nginx -T | grep -nE 'office\.docshub\.space|proxy_pass.*8082' || true
sudo cp /srv/dochub/app/ops/nginx/dochub.conf.template /etc/nginx/conf.d/dochub.conf
sudo nginx -t
sudo systemctl reload nginx
curl --fail --silent --show-error --resolve docshub.space:443:127.0.0.1 \
  https://docshub.space/healthz
sudo nginx -T | grep -nE 'office\.docshub\.space|proxy_pass.*8082' || true
```

The final inspection must show no active `office.docshub.space` server or
ONLYOFFICE upstream in the loaded Docs Hub configuration. Keep any existing
TLS certificate during this change; if it contains the old
`office.docshub.space` SAN, remove that SAN later through a separately planned
Certbot certificate renewal. Do not revoke or delete the certificate as part
of application deployment.

## Deploy and rollback

Run only from a clean checkout at the intended commit:

```bash
cd /srv/dochub/app
./scripts/deploy-production.sh /srv/dochub/.env.production
```

The script validates Compose, builds images, waits for PostgreSQL, runs exactly
one `prisma migrate deploy`, starts the stack, and checks the loopback web
gateway. It never runs `migrate dev`, `db push`, reset, or volume removal.
There are **30** committed Prisma migrations.

For rollback, check out a known-good commit SHA, confirm a clean worktree, and
run the same script. Do not automatically reverse migrations; assess schema
compatibility and restore data only through a tested backup procedure.

See [backup and recovery operations](backup-restore.md) for the encrypted
offsite backup procedure, restore drills, capacity thresholds, TLS operations,
and disaster-recovery order.

## Capacity

The supplied defaults target a VPS with at least 4 GiB RAM: API 768 MiB,
worker 768 MiB, PostgreSQL 1 GiB, and Tika 1 GiB. Do not start the full stack
on a smaller host unless it has been workload-tested with a safe capacity plan.
Do not hide OOM pressure with broad system tuning.
