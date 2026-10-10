# Docs Hub Google Drive architecture

## One company Shared Drive

Docs Hub has one company-wide Google Shared Drive and one singleton
`GoogleDriveIntegration`. All synchronized metadata and all new Drive-backed
content belong to that common corpus. Docs Hub users do not connect personal
My Drives, and `DOCUMENT_MANAGER`/`VIEWER` accounts do not need a Drive
connection of their own.

The integration stores encrypted OAuth credential material, authorized scopes,
connection/sync state, the selected `sharedDriveId` and name, and an optional
physical `storageFolderId`/name. Legacy `DriveConnection` rows are retained
during the transition so old encrypted credentials are not destroyed before
the company integration has been verified. Runtime access uses the company
integration, so removing the administrator who completed OAuth does not remove
company data access.

Only `ADMIN` can connect, reconnect, disconnect, select the Shared Drive, set
the optional physical storage folder, and start metadata sync. The Admin
Google Drive section is the only Drive integration configuration UI. Profile
contains account/Google sign-in information only.

## Company OAuth scopes and reauthorization

The company integration's WRITE authorization requests both
`https://www.googleapis.com/auth/drive.readonly` and
`https://www.googleapis.com/auth/drive.file`. `drive.readonly` is required to
discover Shared Drives with `drives.list` and to read the existing company
Drive corpus. `drive.file` remains required for files that Docs Hub creates or
opens/manages. The broader full `drive` scope is not required.

`drives.list` cannot be authorized by `drive.metadata.readonly` or
`drive.file` alone. Existing connections retain their stored
`authorizedScopes` unchanged; if `drive.readonly` is missing, the API reports
that Shared Drive read authorization is required and the Admin UI asks the
administrator to reconnect. The integration state separately exposes whether
it can discover/read Drive content and whether it can write Docs Hub-managed
files.

## Physical target and API boundary

The selected Shared Drive is the only synchronized source. Drive list requests
use `includeItemsFromAllDrives=true`, `supportsAllDrives=true`,
`corpora=drive`, and the configured `driveId`. Sync does not enumerate a
user's My Drive, `sharedWithMe`, or arbitrary Shared Drives.

New native Docs/Sheets/Slides and binary uploads use the same company
integration and the configured Shared Drive target. If `storageFolderId` is
set, files are created directly under that folder; otherwise they use the
Shared Drive root. Docs Hub never derives a physical Drive parent from a
logical Docs Hub folder and never defaults new content to My Drive.

`DriveFile.driveFileId` is the external identity and is unique in the company
corpus. It is not scoped by a user or a user-owned connection. One company
sync upserts the common `DriveFile` metadata set. Native opening continues to
use Google's `webViewLink`; Drive-backed files do not go through ONLYOFFICE.

## Logical organization and roles

The Shared Drive hierarchy and Docs Hub hierarchy are separate. A Docs Hub
move changes only `Node.parentId`; it does not update Google Drive parents.
“Add to Docs Hub” selects a file from the company Shared Drive corpus and
places a logical reference into the Docs Hub tree.

- `ADMIN`: account administration, integration configuration, document
  organization, and viewing.
- `DOCUMENT_MANAGER`: document organization and viewing; can create/upload
  through the configured company integration.
- `VIEWER`: viewing/browsing only.

Docs Hub roles and Google Shared Drive membership are separate systems. This
checkpoint does not synchronize Google membership or permissions. A
`webViewLink` still requires the viewer's actual Google Workspace access to
the Shared Drive. Future work may map Docs Hub roles to Shared Drive roles.

## Local files and Phase 4A

`StorageService`, `FileVersion`, ONLYOFFICE, and `EditorSession` remain for
existing `LOCAL` files until migration is complete. The standard UI does not
create new local files. Phase 4A resolves the company `GoogleDriveIntegration`
and its Shared Drive target; it does not use
`DRIVE_MIGRATION_OWNER_USER_ID`, and it does not migrate files as part of this
architecture refactor. Audit records use the operator when one exists and
`SYSTEM` for unattended migration work.

Production acceptance after deployment is: configure and verify the Shared
Drive, run metadata sync, create one native document, upload one tiny binary,
verify both are in the same Shared Drive, and only then resume the existing
one-file legacy migration procedure.
