# Google Drive Phase 4A: legacy local-file migration

> Phase 4A uses the company `GoogleDriveIntegration` and configured Drive
> storage folder. No production local file migration is part of this architecture
> refactor.

Phase 4A migrates the current authoritative `FileVersion` for one existing
`File(backingType=LOCAL)` at a time. It does not delete local bytes, remove
`FileVersion` rows, remove ONLYOFFICE, or remove `StorageService`.

## Ownership and safety

Migration resolves the singleton `GoogleDriveIntegration`, which must be
connected with the `drive.file` scope and configured with a storage folder
target. It does not use `DRIVE_MIGRATION_OWNER_USER_ID`; credentials and
physical storage ownership belong to the company integration. An audit record
uses the operator when supplied or `SYSTEM` for unattended work.

The command refuses to start a batch when the company integration, Drive write grant,
configured target, database, or local storage is unavailable. Migration is
never started by application boot or a Prisma migration.

## State machine

Each `(File, sourceVersionId)` has one durable `DriveFileMigration` row:

`PENDING -> UPLOADING -> UPLOADED -> VERIFYING -> VERIFIED -> COMPLETED`

`FAILED`, `BLOCKED`, and `STALE` are retryable operator-visible outcomes.
`ROLLED_BACK` records a successful operator rollback while retaining the
verified Drive object and the local source. A lease token and expiry prevent
two operators from uploading the same source concurrently; an expired lease
can be reclaimed after a process interruption.

The source version is captured before upload. Cutover locks `File`, checks that
`currentVersionId` is still the captured version, and only then changes
`backingType` to `GOOGLE_DRIVE` and attaches the existing `DriveFile` row. If a
new local version appears first, the migration becomes `STALE` and remains
local. The same `Node` and `File` rows, parent, favorites, recents, and all
historical local versions remain unchanged.

## Inventory and commands

Build the API first, then use the explicit operator command:

```text
pnpm build
pnpm migrate:drive -- inventory
pnpm migrate:drive -- --dry-run --limit 10
pnpm migrate:drive -- migrate --file-id <file-id>
pnpm migrate:drive -- migrate --limit 10
pnpm migrate:drive -- migrate --failed-only
pnpm migrate:drive -- status
pnpm migrate:drive -- rollback --file-id <file-id>
```

`inventory` and `--dry-run` perform no Drive upload and no database mutation.
Filters include `--file-id`, `--limit`, `--after`, and `--failed-only`.
Inventory reports logical path, MIME, size, current version, migration state,
missing bytes, invalid current-version metadata, active editing, and partial
Drive references. `status` reports state counts and migrated/remaining bytes.
The inventory item also includes the exact `storageKey`, SHA-256, version
number, and FileVersion source value used for the operator record.

For the first staging run, record the selected Node id, File id, current
version id, SHA-256, size, and logical path from inventory. After migrating one
file, check the Drive object opens with the same name, MIME type, and content;
the Docs Hub File/Node ids and parent are unchanged; favorites and recents still
resolve; and the local storage object is still present. Proceed to ten files
only after those checks pass.

## Upload and verification

The migration opens the exact local `storageKey`, computes SHA-256 while
streaming, and reuses the Phase 3B Google resumable uploader. The original
filename and MIME type are sent as binary metadata, with no Office conversion
and no Docs Hub folder recreation in Drive. The physical destination comes
from the configured Drive target; `Node.parentId` remains the logical Docs Hub
parent.

After Drive returns, the service fetches authoritative file metadata and
checks the ID, name, MIME type, non-trashed state, and size. The local stream's
SHA-256 and size are also checked. Google Drive's `md5Checksum` is recorded
when available for later audit, but the primary content identity remains the
Docs Hub SHA-256. No repeated full download is performed.

If a fresh remote upload is followed by a database registration failure, the
service attempts to delete that unverified remote object. A failed cleanup is
reported as an orphan reconciliation failure. Once a migration is verified or
completed, later unrelated application errors do not automatically delete its
Drive object.

## Runtime and rollback

After cutover, normal runtime opens the Drive `webViewLink`; ONLYOFFICE and
local versioned reads remain available for files still backed by `LOCAL`.
Legacy FileVersion history is retained as a separate pre-migration archive and
is not represented as Google revision history. Migrated files keep the existing
Docs Hub identifiers and logical hierarchy; legacy version restore is hidden by
the existing Drive-backed UI rules.

`rollback --file-id` verifies that the local current version and bytes still
match their recorded SHA-256, locks the file, changes it back to `LOCAL`, and
records `LOCAL_FILE_MIGRATION_ROLLED_BACK`. It does not delete the Drive file.

## Rollout

Use staged batches: inventory only, one known file, ten files, a representative
DOCX/XLSX/PPTX/PDF/image/video sample, one hundred files, then the remaining
eligible set. After each stage inspect failed and blocked rows, Drive opening,
logical parent stability, same Node/File identity, favorites/recents, and local
byte retention. Historical versions and local storage are retired only in a
future phase after the migration is proven.
