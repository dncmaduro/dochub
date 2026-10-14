# Checkpoint 9: revision-aware processing

## What is authoritative

Docs Hub owns the logical `Node` hierarchy and current `FileRevision`; Google
Drive only supplies immutable bytes through the worker's revision-content
provider. `FILE_CONTENT_CHANGED` carries Docs Hub identity only. The worker
resolves the current file and revision itself and never reads legacy
`FileVersion.storageKey` during normal runtime processing, or uses Drive
search, Drive paths, or Drive links. The explicit pre-CP9 backfill command is
the only compatibility path that reads a legacy local `storageKey`.

The current search projection is `SearchDocument(fileId, indexedRevision)`.
`indexedRevision` must equal the `FileRevision.storageRevision` at
`File.revisionSequence`. Both extraction and index publication lock/check that
relationship, so a late result for R10 cannot replace R11. Stale tasks complete
with `lastError = STALE_REVISION`; they do not publish data.

## Pipeline

`Upload`, `Save`, `Restore`, and `Save As Copy` finalize an authoritative
mutation before creating `FILE_CONTENT_CHANGED`. The worker consumes that
outbox event transactionally and de-duplicates tasks by:

`fileId + targetRevision + taskType`

`TEXT_EXTRACTION` stores a bounded `FileTextExtraction` artifact and then
schedules `SEARCH_INDEX`. `SEARCH_INDEX` publishes the current
`SearchDocument`. Leased `SKIP LOCKED` claiming, attempt counters, expiry, and
lease tokens protect multi-worker operation and crash recovery. Retryable
storage/Tika errors back off; malformed, unsupported, and size-limited content
does not retry forever. Filename search remains independent of extraction.

Native extraction currently covers TXT, Markdown, JSON, XML, CSV, DOCX, XLSX,
and PPTX. PDF and legacy DOC/XLS/PPT use the bounded Tika fallback. Image,
audio, and video are deliberately not text-extracted. Extracted text is capped
by byte and character limits; truncation is recorded. No content is logged.

The current runtime has no safe image/PDF rasterizer dependency, so file
thumbnails are intentionally `NOT_APPLICABLE` in this deployment; the UI keeps
its established file-type icon fallback. No provider `thumbnailLink` is
exposed or used. A thumbnail processor can be added as another revision-keyed
task once a bounded renderer and derived-artifact store are introduced.

## Search behavior

Search is authenticated and server-side permission filtered before any name,
file ID, or snippet is returned. It excludes trashed nodes and uses logical
Docs Hub breadcrumbs in the UI. PostgreSQL `simple` text search plus an
GIN-backed `searchVector` plus an accent-folded comparison supports Vietnamese token search and accent-folded
filename matching; it does not promise arbitrary Vietnamese linguistic
stemming. Results rank exact name, name prefix, name token/similarity, then
content rank. Content snippets are bounded plain text; the React UI renders
them as text rather than HTML. Responses are `private, no-store`.

## Audit classification

| Area | Decision |
| --- | --- |
| `SearchDocument` / PostgreSQL GIN search / ACL filter / search UI | ADAPT |
| leased `FileProcessingTask` mechanics | ADAPT |
| outbox finalization after CP8.1 mutation reconciliation | KEEP and connect |
| legacy local `FileVersion` processing and `storageKey` reads | DEPRECATE (legacy rows remain readable) |
| worker-local Tika-only architecture | REPLACE with native-first extraction plus Tika fallback |
| Drive direct search/hierarchy/native semantics | REJECTED |
| existing LibreOffice preview path | KEEP for preview only; not a modern extraction authority |

## Backfill and deployment

Deploy in this order: database migration, API, worker, then web. Verify API
and worker health first. Backfill is explicit and one bounded batch at a time.
The command covers both provider-backed files and pre-CP9 local files: the
latter are read from their current `FileVersion` only during this command when
`STORAGE_ROOT` is configured, then written with the legacy version pointer.
Normal worker startup never scans that legacy corpus.

```sh
pnpm --filter worker build
pnpm --filter worker backfill:file-processing -- --limit 20 --dry-run
pnpm --filter worker backfill:file-processing -- --limit 20
```

Use the returned `nextCursor` to resume. Observe worker CPU/RAM and failure
logs before increasing a batch size. Do not enqueue the corpus during API or
worker startup.
