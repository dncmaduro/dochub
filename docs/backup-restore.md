# Production backup and recovery

Docs Hub uses encrypted, deduplicated **offsite** restic snapshots. A directory
on the same VPS is not a backup destination. The backup contains a PostgreSQL
custom-format logical dump, `/srv/dochub/storage`, `.env.production`, and a
non-secret manifest. It never backs up the restic password/config itself.

## First-time setup and audit

On the VPS, inspect `df -h`, `docker system df`, `du -sh /srv/dochub/{storage,postgres}`, `timedatectl`, `systemctl list-timers`, crontab, existing dumps/archives, `nginx -T`, and `certbot certificates`. Record the host Nginx and Certbot state; the sanitized [Nginx template](../ops/nginx/dochub.conf.template) is the recovery reference. Audit `restic`, `rclone`, and `borg` before choosing a backend; these scripts use restic unless an established equivalent is demonstrably better.

Create `/srv/dochub/.backup.env` from `ops/backup.env.example`, set mode 0600,
and keep `RESTIC_PASSWORD_FILE` mode 0600. Configure a remote restic backend
and run `restic init` manually. Do not put these credentials in Git or
`.env.production`. Install restic explicitly as an operator prerequisite; the
scripts fail clearly if it is absent and never install packages. Install the
systemd templates only after a manual backup and restore drill pass:
`systemctl enable --now dochub-backup.timer dochub-backup-verify.timer`.

`dochub-backup.timer` runs at 02:30 in the audited `Asia/Ho_Chi_Minh` VPS
timezone and uses `Persistent=true`. Leave it disabled until restic, an offsite
backend, a manual backup, verification, and an isolated restore drill have all
succeeded. The lock prevents overlap; the script exits 75 when active EDIT
sessions exist rather than terminating users' editing sessions.

For the backup window, PostgreSQL remains running for `pg_dump`; `api`,
`worker`, and `onlyoffice` stop because they can respectively accept writes,
purge/process mutable state, and submit editor callbacks. The static `web`
gateway also stops so it presents a short maintenance outage rather than broken
write routes. Tika is stateless and remains running. This leaves no process
able to mutate database metadata or immutable storage between dump and snapshot.

## Operations

Run `scripts/production-status.sh` for service state, public health, disk/RAM,
storage and PostgreSQL size, snapshot status, migration timestamp, and TLS
expiry. Logs: `docker compose ... logs api`, `worker`, `tika`, or `onlyoffice`;
backup logs: `journalctl -u dochub-backup.service`; host proxy errors:
`journalctl -u nginx` (or the distribution's Nginx error log).

Compose rotates container json logs (10 MiB × 3). Never automate `docker system
prune -a` or `docker volume prune`: images/build cache, running images, and
persistent data are different things. Investigate `docker system df` first.
If capacity work is required, review build-cache cleanup and unused-image
cleanup separately from current/running images and volumes; do not automate
either broadly. Docker logging changes take effect only when containers are
recreated by a normal deployment. Keep at least 1 GiB free for the temporary
database dump by default (`BACKUP_MIN_FREE_KB` is configurable) plus headroom
for the dump's expected size. The audited host currently has 4.7 GiB free and
a 9.1 MB database; review this floor as PostgreSQL grows. Restore drills need
space for the full restored storage and should normally run on another machine.

Run `scripts/backup-production.sh`; optional `--prune` is explicit and only
runs after a successful snapshot. Retention defaults are 7 daily, 4 weekly,
and 6 monthly snapshots. `scripts/verify-production-backup.sh` checks age,
required content, and repository access; `--full` adds the expensive integrity
check. The status command reports `backup=not_configured` until this setup
exists. The host's Certbot timer is enabled; the audited SAN certificate covers
`docshub.space` and `office.docshub.space` and was valid through 2027-01-01 at
audit time, not as a future guarantee. Check current state with `systemctl
status certbot.timer --no-pager`, `systemctl list-timers | grep -i certbot`,
and `certbot certificates`; test renewal only with an explicitly approved
`certbot renew --dry-run`. Certificate paths are under
`/etc/letsencrypt/live/`, but private keys are not the recovery plan.

## Restore drill and disaster recovery

Run `scripts/restore-production-drill.sh --snapshot SNAPSHOT` only with an
isolated target. It restores a disposable PostgreSQL container, checks core
tables, every `FileVersion.storageKey`, and every stored SHA-256. It never
targets live PostgreSQL or live document storage. Search documents are derived
data; metadata, immutable bytes, ACLs, users, and version history are the
recovery proof. Restore checks can reveal that search content needs normal
worker reprocessing.

For a full VPS loss: provision a replacement, install Docker/Compose and host
Nginx, deploy the intended Git SHA, configure DNS and `/srv/dochub/.env.production`,
initialize PostgreSQL, restore the logical dump and storage, verify
FileVersion/storage integrity, run `migrate deploy` only when moving an older
snapshot to a newer app schema, start services, reissue TLS, verify OAuth
redirects, then perform acceptance smoke tests. Preserve outside the VPS:
Google OAuth credentials, application/ONLYOFFICE secrets, database credentials,
restic repository/password/backend credentials, DNS access, and GitHub deploy
access.

Application failure: rebuild/restart the affected service. Bad deployment:
deploy a known-good SHA through GitHub Actions; do not reverse Prisma
migrations. Database or storage loss: use the verified snapshot and isolated
drill procedure. Live restore is deliberately manual and requires a fresh
safety backup, stopped writers, explicit target verification, and a separate
approved cutover; there is no one-command live restore.
