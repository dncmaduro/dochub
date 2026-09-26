# Standalone retention worker

The worker boots with `NestFactory.createApplicationContext`. It has no HTTP
server, controllers, API calls, queue, or Outbox retention job. It calls the
shared `@dochub/trash` `TrashPurgeEngine` directly using SYSTEM / null audit
attribution. Manual API purge continues to require authenticated user DELETE ACL.

Use Node 22.23.2 (`nvm use`) and pnpm 9.15.5. The existing Node `--env-file-if-exists`
startup/test scripts load the repository root `.env`; no additional env loader
is used. Configure `DATABASE_URL`, `STORAGE_DRIVER=local`, and an absolute
`STORAGE_ROOT` matching the API's binary storage in production.

| Setting | Default | Validation |
| --- | --- | --- |
| `TRASH_RETENTION_POLL_SECONDS` | 60 | Positive finite seconds fitting a Node timer (maximum 2147483.647) |
| `TRASH_RETENTION_BATCH_SIZE` | 20 | Integer 1–500 |
| `TRASH_RETENTION_OPERATION_CONCURRENCY` | 1 | Integer 1–8 |

An immediate startup cycle selects expired ACTIVE operations (`expiresAt <= now`)
and all PURGING operations. RESTORED, PURGED, and unexpired ACTIVE operations are
excluded. The engine rechecks lifecycle state under its database lock; the worker
also rechecks retention eligibility there without resolving user ACL.

Each cycle processes at most one configured batch. Candidate selection walks IDs
in ascending order after a process-local cursor, wrapping at most once and filling
only the remaining batch capacity. The cursor advances on attempts, including
failures, so a permanently failing PURGING operation cannot monopolize batch size
1 or starve expired ACTIVE work. A restart resets the cursor.

A fixed-size operation pool bounds concurrency. The next timer is scheduled only
after the current cycle settles; concurrent calls to `runCycle()` share its
promise. Shutdown clears the timer, prevents queued operations from starting, and
waits for current work before database disconnection. Storage failures leave
PURGING metadata for recovery on a later cycle. Database selection errors are
logged and retried at the next poll.

Multiple workers provide at-least-once, idempotent processing. Physical deletion
may be attempted more than once. The shared engine serializes structural
finalization, retaining operation history and one successful NODE_PURGED audit.
No schema or migration is added.

```sh
pnpm --filter worker start:dev
pnpm --filter worker test             # units, then serialized PostgreSQL integration
pnpm --filter worker test:integration
pnpm --filter worker test:e2e          # real application context and database
pnpm --filter worker lint
```

Integration and e2e tests require PostgreSQL and fail when DATABASE_URL is absent.
They use fixture-scoped candidate queries and temporary LocalFileStorage roots,
cleaning only fixture records and binaries. Never smoke-test retention against
real document storage: use isolated STORAGE_ROOT and controlled fixtures or
confirm that the database contains no eligible operations before starting.
