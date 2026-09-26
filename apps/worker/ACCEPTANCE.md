# Checkpoint 24B — local acceptance

Accepted locally on 2026-09-26. Starting branch: `main`, commit `0fa65ba`
(Checkpoint 24A), initially clean. Inspection found no existing 24B retention
implementation. Added the requested standalone worker retention implementation;
the shared purge engine and API production authorization code remain unchanged.
No commit or staging was performed.

| # | Requested check | Result |
| --- | --- | --- |
| 1 | Node | **v22.23.2**, selected through the existing nvm setup before acceptance |
| 2 | pnpm | **9.15.5** |
| 3 | Storage tests | **10/10 passed**, zero skipped |
| 4 | `@dochub/trash` tests | **2/2 PostgreSQL integration tests passed**, zero skipped |
| 5 | Worker unit tests | **30/30 passed** across 2 specs |
| 6 | Worker e2e | **1/1 passed** using the real application context, PostgreSQL and temporary LocalFileStorage |
| 7 | Expired ACTIVE real purge | Passed; observed ACTIVE → PURGING → PURGED; Node, File and FileVersion removed; operation history retained |
| 8 | Physical binary deletion | Existed before deletion, absent afterwards, using isolated temporary storage |
| 9 | SYSTEM audit | Exactly one successful NODE_PURGED audit, actorType SYSTEM, actorId null |
| 10 | Unexpired ACTIVE exclusion | No attempt; binary and metadata remain; no purge audit |
| 11 | RESTORED exclusion | Old RESTORED operation not selected or processed |
| 12 | PURGED exclusion | Old PURGED operation not selected or processed |
| 13 | PURGING failure/recovery | Controlled storage failure retained all metadata and no success audit; next cycle recovered, including PURGING with future expiry |
| 14 | ACL-independent retention | Purged an expired root document with no permissions, no parent, inheritance disabled and public access disabled; worker resolves no user ACL |
| 15 | Manual USER purge regression | Unauthenticated DELETE returns 401; invisible user 404; Viewer 403; ADMIN without ACL 404; trashedById alone 404; successful audit explicitly verified USER |
| 16 | Fairness | Ascending-ID cursor advances on every attempt, including failures, and wraps at most once; batch-size-1 test proves persistent PURGING failure does not starve expired ACTIVE |
| 17 | Batch limit | Five eligible fixtures with batch 2 processed in counts **2, 2, 1**, never a full-table drain |
| 18 | Operation concurrency | Fixed-size pool; instrumentation held five operations and observed maximum 2 with concurrency 2; config supports 1–8 |
| 19 | Non-overlap | Fake timers advanced 10 seconds during a blocked cycle; no second selection or purge began; concurrent triggers share the current promise |
| 20 | Graceful shutdown | Timer cleared, no rescheduling, no queued work started, active purge awaited; also tested shutdown during candidate selection and selection failure; real context close waited for blocked first purge |
| 21 | Multi-worker result | Two services and a storage barrier forced two physical deletion attempts; eventual PURGED, binary and metadata gone, exactly one successful structural audit; at-least-once/idempotent |
| 22 | API unit count | **76/76** across 16 specs per full run |
| 23 | API PostgreSQL count | **32/32** across 4 serialized integration specs per full run |
| 24 | Three API runs | **Run 1: 76 + 32 passed; Run 2: 76 + 32 passed; Run 3: 76 + 32 passed.** No skips or serialization failures |
| 25 | API e2e | **17/17 passed** across 2 specs |
| 26 | Worker lint | Passed, no warnings/errors in final version |
| 27 | API lint | Passed; existing unbound-method warnings in unchanged test files only |
| 28 | Workspace build | `pnpm build` passed for all 6 workspace packages/apps |
| 29 | Prisma validate | Passed with root .env loaded |
| 30 | Migration status | **8 migrations; database up to date** |
| 31 | Worker smoke | Built production entry point started with a temporary STORAGE_ROOT after checking zero eligible or soon-expiring operations; immediate zero-operation cycle; lsof confirmed no TCP listener; SIGTERM stopped retention before DB disconnect and process exited cleanly |
| 32 | Modified files | Listed below; retention implementation and tests added, scaffold removed, manual API test assertions strengthened; no changes to shared engine or API production code |
| 33 | Final git status | `main`; **9 modified, 3 deleted, 9 untracked source/config/doc files**; nothing staged or committed; `git diff --check` clean |
| 34 | No schema/migration changes | Confirmed; schema and migrations have no diff |
| 35 | No HTTP server | Confirmed in source, application-context e2e and actual process smoke; worker controller scaffold removed |
| 36 | No BullMQ/Redis queue | Confirmed; no worker queue, API call, fake user/token, Outbox retention job or cron framework. Existing infrastructure includes Redis, but retention does not use it |
| 37 | Checkpoint acceptance | **Checkpoint 24B fully accepted locally** |
| 38 | Remaining blocker | **None** |

The final worker PostgreSQL suite passed **8/8 three times**, including the forced
multi-worker race. The root `.env` was loaded through the existing Node env-file
mechanism; no secrets were printed and no extra env loader was added. Docker
Desktop was initially stopped; the existing `pnpm infra:up` command started the
configured infrastructure without resetting database data.

Configuration is documented in `.env.example`: polling defaults to 60 seconds,
batch size to 20 and concurrency to 1. Polling must be positive and finite and fit
the Node timer range; batch is an integer 1–500; concurrency is an integer 1–8.
The first cycle launches immediately without blocking application bootstrap, so
main can install shutdown signal handlers while work is running.

## Changed files

Modified:

- `.env.example`
- `apps/api/src/trash/trash.service.integration.spec.ts` — explicitly checks USER audit attribution
- `apps/api/test/app.e2e-spec.ts` — unauthenticated manual purge regression
- `apps/worker/README.md`
- `apps/worker/package.json`
- `apps/worker/src/app.module.ts`
- `apps/worker/test/app.e2e-spec.ts`
- `apps/worker/vitest.config.ts`
- `pnpm-lock.yaml`

Removed unused scaffold:

- `apps/worker/src/app.controller.spec.ts`
- `apps/worker/src/app.controller.ts`
- `apps/worker/src/app.service.ts`

Added:

- `apps/worker/ACCEPTANCE.md`
- `apps/worker/src/retention/retention.config.ts`
- `apps/worker/src/retention/retention.config.spec.ts`
- `apps/worker/src/retention/retention.module.ts`
- `apps/worker/src/retention/retention.service.ts`
- `apps/worker/src/retention/retention.service.spec.ts`
- `apps/worker/test/retention-fixture.ts`
- `apps/worker/test/retention.integration.spec.ts`
- `apps/worker/vitest.config.integration.ts`

Generated untracked dist files were removed after validation. Pre-existing tracked
build outputs and build-info files were restored to their initial contents, so
none are part of this change. Rebuild before the next runtime invocation. Tests
removed their temporary storage and fixture records. No coverage or upload
artifacts are included.
