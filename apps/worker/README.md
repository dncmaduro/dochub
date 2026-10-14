# Standalone retention worker

The worker boots with `NestFactory.createApplicationContext`. It has no HTTP
server, controllers, or API callback path. It calls the
shared `@dochub/trash` `TrashPurgeEngine` directly using SYSTEM / null audit
attribution. Manual API purge continues to require authenticated user DELETE ACL.

Use Node 22.23.2 (`nvm use`) and pnpm 9.15.5. The existing Node `--env-file-if-exists`
startup/test scripts load the repository root `.env`; no additional env loader
is used. Configure `DATABASE_URL`, the Google OAuth client credentials, and
`DRIVE_TOKEN_ENCRYPTION_KEY`. Local storage remains configured for the legacy
retention worker; provider-revision processing reads through its Drive adapter.

## File processing reliability

`FILE_CONTENT_CHANGED` is consumed only after authoritative mutation
finalization. The worker resolves the current `FileRevision`, creates unique
`(fileId, targetRevision, type)` tasks, then runs `TEXT_EXTRACTION` followed by
`SEARCH_INDEX`. It does not use `FileVersion.storageKey` as authority. At most
`FILE_PROCESSING_BATCH_SIZE` tasks are claimed per poll and
`FILE_PROCESSING_CONCURRENCY` tasks run concurrently.

Each successful claim increments `attemptCount`, writes a UUID lease token, and
sets a lease expiry. A worker can publish an extraction artifact,
`SearchDocument`, or transition a task only while it still owns that token.
Expired work is safely reclaimable; a delayed owner cannot overwrite a new
owner. Publication locks the file and requires the matching current provider
revision, so a late historical result cannot replace newer searchable content.

Native extraction handles text, CSV, DOCX, XLSX, and PPTX. Tika is a bounded
fallback for PDF and legacy Office data. Retryable provider/Tika failures use
60s, 120s, 240s, 480s, then capped 900s backoff. Unsupported, malformed, and
size-limited input is terminal without invalidating the source file. Shutdown
stops new claims, waits for started operations, and safely leaves interrupted
work for lease recovery.

| Setting                                 | Default | Validation                                                         |
| --------------------------------------- | ------- | ------------------------------------------------------------------ |
| `TRASH_RETENTION_POLL_SECONDS`          | 60      | Positive finite seconds fitting a Node timer (maximum 2147483.647) |
| `TRASH_RETENTION_BATCH_SIZE`            | 20      | Integer 1–500                                                      |
| `TRASH_RETENTION_OPERATION_CONCURRENCY` | 1       | Integer 1–8                                                        |
| `FILE_PROCESSING_POLL_SECONDS`          | 15      | Integer 1–2147483                                                  |
| `FILE_PROCESSING_BATCH_SIZE`            | 20      | Integer 1–500                                                      |
| `FILE_PROCESSING_CONCURRENCY`           | 2       | Integer 1–8                                                        |
| `FILE_PROCESSING_LEASE_SECONDS`         | 300     | Integer 1–3600; exceeds Tika timeout by 30 seconds                 |
| `FILE_PROCESSING_MAX_ATTEMPTS`          | 5       | Integer 1–20                                                       |
| `FILE_PROCESSING_OUTBOX_BATCH_SIZE`     | 50      | Integer 1–500                                                      |
| `FILE_EXTRACTION_MAX_BYTES`             | 25 MiB  | Integer 1–200 MiB                                                  |
| `FILE_EXTRACTION_MAX_CHARS`             | 2M      | Integer 1–10M                                                      |
| `TIKA_REQUEST_TIMEOUT_SECONDS`          | 60      | Integer 1–600                                                      |

The explicit `backfill:file-processing` command also reads pre-CP9 local
`FileVersion` rows (when `STORAGE_ROOT` is configured) and publishes their
current content into the same `SearchDocument` projection. This compatibility
pass is never run by normal worker startup; binary media remains
filename-searchable through the API.

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
WORKER_TEST_DATABASE_URL=postgresql://.../dochub_worker_test pnpm --filter worker test
WORKER_TEST_DATABASE_URL=postgresql://.../dochub_worker_test pnpm --filter worker test:integration
pnpm --filter worker test:e2e          # real application context and database
pnpm --filter worker lint
```

Worker integration tests require `WORKER_TEST_DATABASE_URL`, which must name a
dedicated database ending in `_worker_test`; it is migrated before the run and
truncated before and after the serialized suite. This prevents the worker's
global backfill cursor and leased task claims from observing a developer DB.
Fixtures also use temporary LocalFileStorage roots. Never point this URL at a
development or production database. E2E tests remain separately configured.
