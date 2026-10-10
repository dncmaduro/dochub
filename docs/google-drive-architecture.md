# Docs Hub Google Drive architecture

## One company Google Drive integration

Docs Hub has exactly one company-wide `GoogleDriveIntegration`. It represents
one connected Google account and one configured Google Drive folder. The folder
may be in My Drive or another location the account can access; a Shared Drive
is not required.

The integration stores encrypted OAuth credential material, authorized scopes,
connection/sync state, and the selected `storageFolderId`/name. The old
nullable `sharedDriveId`/name columns remain for safe compatibility with
existing rows, but runtime readiness and target resolution use the connected
account, OAuth scopes, and `storageFolderId` only. Legacy `DriveConnection`
rows are also retained and are not destructively migrated.

Only `ADMIN` can connect, reconnect, disconnect, choose the storage folder,
and start metadata sync. The Admin Google Drive section is the only Drive
integration configuration UI. Profile contains account/Google sign-in
information only.

## OAuth scopes and folder validation

The read authorization requests
`https://www.googleapis.com/auth/drive.readonly`. The WRITE authorization
requests that scope plus the least-privilege
`https://www.googleapis.com/auth/drive.file` scope. The broader full `drive`
scope is not requested.

Folder selection lists accessible Drive folders through the Drive files API and
validates the selected ID with a metadata request. The target must be a folder;
an inaccessible target returns a typed access error, and a folder whose Drive
capabilities explicitly deny adding children returns a typed write-access
error. The service never accepts an unvalidated browser-supplied folder as a
storage target.

Existing connections retain their stored `authorizedScopes` unchanged. If
`drive.readonly` is missing, the API reports
`GOOGLE_DRIVE_READ_AUTHORIZATION_REQUIRED`; if `drive.file` is missing, writes
report `GOOGLE_DRIVE_WRITE_AUTHORIZATION_REQUIRED`. The Admin UI exposes read,
write, account, storage-folder, sync, and reauthorization state separately.

The `drive.file` scope is retained for least-privilege writes. It is not
replaced with full `drive`; the configured folder is validated through the
Drive API, and any Google permission or per-file authorization limitation is
returned as a safe typed error.

## Physical target and sync boundary

The physical target is `{ type: 'DRIVE_FOLDER', parentFolderId }`. New native
Docs/Sheets/Slides, binary uploads, and Phase 4A migration uploads always send
`parents: [storageFolderId]`. No creation path derives a Google parent from a
Docs Hub folder or falls back to the acting user's My Drive.

The primary browser is provider-backed and reads the configured folder's
subtree live. It lists direct children with `'<folderId>' in parents`, traverses
nested folders, and ignores unrelated My Drive files and files outside the
subtree. Search and import therefore do not require a prior metadata sync.
The browser does not use Shared Drive discovery, `corpora=drive`, or a `driveId`
filter.

Sync remains metadata-only reconciliation for the same subtree. It refreshes
the local `DriveFile` catalog and marks metadata that is no longer returned as
unavailable; it is not a prerequisite for browsing or adding a logical
reference.

`DriveFile.driveFileId` remains the external identity and is unique in the
company corpus. `DriveFile.location` and the nullable `sharedDriveId` field
are retained as source metadata when Google supplies it; neither is required
for a normal My Drive folder. `DriveFile` rows store metadata only.

## Logical organization and roles

The Google Drive physical folder is not the Docs Hub logical hierarchy. A
Docs Hub move changes only `Node.parentId`; it never changes a Google Drive
parent. “Add to Docs Hub” live-validates and records a metadata-only logical
reference to a Drive file without relocating the source file.

- `ADMIN`: account administration, integration configuration, document
  organization, and viewing.
- `DOCUMENT_MANAGER`: document organization and viewing; can create/upload
  through the configured company integration.
- `VIEWER`: viewing/browsing only.

Docs Hub roles and Google permissions remain separate. A `webViewLink` still
requires the viewer's actual Google access to the source file.

## Local files and Phase 4A

`StorageService`, `FileVersion`, ONLYOFFICE, and `EditorSession` remain for
existing `LOCAL` files until migration is complete. The standard UI does not
create new local files. Phase 4A resolves the company integration and its
configured storage folder; it does not start migration during boot or a Prisma
migration. Audit records use the operator when one exists and `SYSTEM` for
unattended work.

Production acceptance is: connect the company account, choose and validate a
storage folder, browse and import a live file without syncing first, run a
metadata reconciliation, create one native document, upload one tiny binary,
and verify that both are under that folder before resuming the existing
one-file legacy migration procedure.
