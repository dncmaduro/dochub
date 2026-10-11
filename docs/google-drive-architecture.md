# Docs Hub Google Drive implementation notes

> Canonical product direction: [Docs Hub file, storage, and engine architecture](file-storage-and-engine-architecture.md).
> This document records the current Google-specific integration and its
> transitional behavior. Google Drive is a storage backend, not the Docs Hub
> product document model.

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

The physical target is `{ type: 'DRIVE_FOLDER', parentFolderId }`. Binary
uploads and Phase 4A migration uploads currently send
`parents: [storageFolderId]`. No creation path derives a Google parent from a
Docs Hub folder or falls back to the acting user's My Drive. The legacy native
Docs/Sheets/Slides endpoint is retained only for staged migration and is no
longer called by the normal Docs Hub UI.

The optional transitional Drive browser is provider-backed and reads the
configured folder's subtree live. It lists direct children with
`'<folderId>' in parents`, traverses nested folders, and ignores unrelated My
Drive files and files outside the subtree. Its search is scoped to the
currently open physical folder's direct children. This browser is an import
utility, not the primary Docs Hub product experience; Docs Hub search is the
long-term document search surface.
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

Docs Hub roles and Google permissions remain separate. Docs Hub authorization
is the normal product-level access authority; company Drive credentials are
infrastructure. A `webViewLink` is retained only for an explicit transitional
Edit in Google action and is not the normal open path.

## Editing, preview, and legacy local files

For Drive-backed content, Google Drive currently stores the physical bytes.
Every primary file activation stays in Docs Hub and opens its PreviewDialog.
Native Google Docs, Sheets, and Slides are exported by Drive as PDF for
transitional preview. Microsoft Office files are downloaded to an isolated
temporary API directory, converted to PDF by headless LibreOffice, streamed
into the dialog, and removed after the response. The Drive `webViewLink` is
used only by an explicit Edit in Google action; Docs Hub does not run an
embedded office editor.

`StorageService` and `FileVersion` remain for existing `LOCAL` files and for
the controlled migration/restore procedures. Historical `EditorSession` data
and its Prisma migrations are retained only as database compatibility and
cleanup records; the active API, UI, Docker runtime, and Nginx configuration
no longer create or serve ONLYOFFICE sessions. The standard UI does not create
new local files. Phase 4A resolves the company integration and its configured
storage folder; it does not start migration during boot or a Prisma migration.
Audit records use the operator when one exists and `SYSTEM` for unattended
work.

The historical production acceptance sequence may still be used to validate
the integration, but native Google creation is not current product direction.
The current target acceptance is to connect the company account, choose and
validate a storage folder, upload a physical file through Docs Hub, preview it
inside Docs Hub, and verify the logical `Node.parentId` independently of the
physical Drive parent before resuming the existing one-file legacy migration
procedure.
