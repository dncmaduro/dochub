# Google Drive Phase 3B: binary uploads

> Uploads use the company integration and selected Shared Drive. A
> `DOCUMENT_MANAGER` never connects a personal Drive before uploading.

## Resulting content model

After Phase 3B, every new file created through the normal Docs Hub UI is
Google Drive-backed: native Docs/Sheets/Slides use the Phase 3A flow and binary
uploads keep their original file format in Drive. Docs Hub folders remain
logical containers. Existing `LOCAL` files remain readable and editable during
the migration period.

The legacy `POST /files` local upload route remains available for migration and
internal use, but is deprecated and is no longer called by the normal Upload
action. It must not be used as a fallback when Drive is disconnected or only
has metadata-read authorization.

## Upload route and streaming

The normal UI sends one file per request to authenticated `POST /drive/uploads`
as multipart form data, with a `parentId` field followed by a `file` field and a
required `Idempotency-Key` header. The parent ID is a Docs Hub logical folder
reference. The API never accepts a Google Drive parent ID, Drive file ID, or
OAuth token from the browser.

Busboy streams the file part through a bounded validation transform and into a
Google Drive resumable upload session. The provider sends Drive chunks of up to
8 MiB and waits for each response before sending the next chunk, preserving
backpressure. If Drive acknowledges only part of a chunk, the provider resumes
from the accepted byte range; after a network or 5xx response it queries the
session status before retrying. Unrecoverable failures abort the session on a
best-effort basis. Memory use is bounded by the current/pending chunk buffers, the
multipart stream buffers, an 8 KiB signature prefix, and a rolling 1 MiB tail
used to validate Office ZIP package markers. The complete upload is never
buffered in Node.js memory and no upload temp file is created.

The resumable session URI and OAuth access token stay in API process memory.
They are never returned to the browser, stored in the database, or written to
logs. There is no explicit cancel control in the UI; closing/aborting the
request stops the stream and triggers session abort.

## Size and MIME policy

The application limit is `UPLOAD_MAX_BYTES`, configured as a positive integer
and enforced while streaming by both Busboy and the validation transform. The
checked-in production example sets it to 536,870,912 bytes (512 MiB). Production
Nginx allows 513 MiB for multipart framing and has request buffering disabled
for the app proxy path. An oversized file stops Drive transfer, aborts the
resumable session, and returns HTTP 413; the parser drains/discards the
remaining request body so the response can be sent without leaving a local
artifact.

Validation uses the sanitized extension, the declared MIME when it is specific,
and magic bytes/package markers. Supported formats follow the existing local
upload policy: PDF; DOC/DOCX; XLS/XLSX; PPT/PPTX; JPEG, PNG, WebP, GIF; MP4,
WebM, and MOV. Office files remain binary and are not converted to native Google
formats. The validated MIME is passed to Drive unchanged.

## Authorization and Drive scope

The backend requires an authenticated, `ACTIVE` user with
`canManageDocuments`: `ADMIN` and `DOCUMENT_MANAGER` are allowed; `VIEWER` is
denied. This upload path uses the system role and does not consult legacy
`PermissionEntry` ACLs. The UI hides Upload for viewers.

A connected company integration must include the existing `drive.file` write
grant and `drive.readonly` for Shared Drive discovery. Integrations missing
the read grant receive a typed
`GOOGLE_DRIVE_READ_AUTHORIZATION_REQUIRED` response, while integrations missing
the write grant receive `GOOGLE_DRIVE_WRITE_AUTHORIZATION_REQUIRED`. The UI
offers the existing bounded Admin reauthorization flow. The upload does not
broaden OAuth scopes beyond `drive.readonly` plus `drive.file`.

## Physical and logical placement

The API chooses the physical Google Drive parent from the company integration's
Shared Drive target. It never derives a Google parent from the Docs Hub folder.
In Docs Hub, the new `Node.parentId` records the selected
logical folder. Moving that Node later does not change the physical Drive
parent.

After Drive confirms an upload, one database transaction upserts `DriveFile`
by the globally unique `driveFileId`, creates a `Node(type=FILE)` and a
`File(backingType=GOOGLE_DRIVE)`, and records `GOOGLE_DRIVE_FILE_UPLOADED`.
Logical name conflicts keep the existing `name (1).ext` convention. The remote
Drive name uses the same allocated name as the Node.

The transaction creates no `FileVersion`, `storageKey`, local storage object,
processing task, or `EditorSession`. Search discovers the Node by filename and
its file type comes from `DriveFile` metadata; binary content is not indexed.
Favorites and Recent continue to use the Docs Hub Node. Opening a Drive-backed
upload uses its Google `webViewLink`, including DOCX/XLSX/PPTX; ONLYOFFICE
continues to serve legacy local office files. Version history and Docs Hub
sharing controls remain hidden for Drive-backed files.

## Idempotency and failures

`DriveUploadOperation` claims the idempotency key before contacting Drive and
stores request metadata plus the completed byte count and SHA-256 digest. A
concurrent request with the same key cannot start another Drive upload. A
successful replay consumes and validates the repeated body, checks the digest,
and returns the existing logical result. Reusing a key for different metadata
or bytes returns a conflict. The separate upload operation record is retained
because binary requests need original filename, MIME, size, and content digest;
the Phase 3A native-document operation has a different typed payload.

If Drive fails before creating the file, the operation is marked failed and no
Docs Hub file row is created. If Drive succeeds but the database registration
fails, the API attempts to delete the new Drive file. A successful compensation
returns failure and marks the operation failed. If compensation also fails,
the API writes `GOOGLE_DRIVE_FILE_ORPHANED` with safe reconciliation metadata
and returns an error identifying the Drive file ID; it does not report success.

The immediate upsert and later metadata sync use the same Drive file ID, so
sync updates the existing `DriveFile`. External Drive renames are mirrored to
the linked Node under the Phase 2 name-conflict policy. Disconnecting the
company integration does not delete logical references; existing source state
follows the Phase 2 STALE/UNAVAILABLE behavior, and new writes require an
Admin to restore the company integration.

## UI limits and validation

The current Upload input accepts one file at a time, matching the legacy UI.
The UI displays an uploading state, success, or failure; it does not fabricate
a percentage. Every file request has its own idempotency key. Automated
validation is recorded in the Phase 3B implementation report and the manual
write-authorized Google account acceptance checks still need to be completed in
an environment with that account.
