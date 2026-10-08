# Google Drive Phase 3A: native document creation

> Native creation uses the company `GoogleDriveIntegration` and its configured
> Shared Drive target. It never uses the acting user's My Drive.

Phase 3A makes the Docs Hub **New** menu create native Google Workspace files:

- `DOCUMENT` → `application/vnd.google-apps.document`
- `SPREADSHEET` → `application/vnd.google-apps.spreadsheet`
- `PRESENTATION` → `application/vnd.google-apps.presentation`

The Docs Hub folder is still the logical parent. The Drive API parent is a
separate creation target configured by an administrator in the Admin Drive
integration section. The target is the selected Shared Drive root or its
optional physical storage folder, and creation requests use
`supportsAllDrives=true`.

## Authorization and capability

Initial connection remains metadata read-only:
`https://www.googleapis.com/auth/drive.metadata.readonly`.

Document managers and administrators can request incremental write capability
with the least-privilege `https://www.googleapis.com/auth/drive.file` scope.
Existing connections remain read-only until that explicit reauthorization is
completed. `GoogleDriveIntegration.authorizedScopes` is persisted and the API
exposes `canWrite`; only an administrator configures or reauthorizes the
company integration, while viewers cannot create native documents.

Imported Drive files remain metadata-backed and read-only in Docs Hub. Native
creation does not inherit local folder ACL restrictions, while legacy local
creation boundaries remain unchanged.

## Creation and recovery

`POST /drive/documents` requires `kind`, accepts an optional logical `parentId`
and `locale`, and requires an `Idempotency-Key` header. The key is stored in
`DriveCreationOperation`. A completed request is replay-safe; a concurrent
request receives an in-progress conflict instead of creating a second Drive
file.

Creation writes the remote native file first, then transactionally records the
Drive metadata, logical node, file backing, operation result, and audit event.
If registration fails, Docs Hub attempts to delete the remote file. A failed
compensation is recorded as `GOOGLE_DRIVE_DOCUMENT_ORPHANED` with the remote
file ID in audit metadata for reconciliation.

The legacy `/files/create` endpoint remains for existing local Office files but
is deprecated for the normal UI; it is not used by the Phase 3A New menu.
