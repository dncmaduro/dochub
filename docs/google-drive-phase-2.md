# Google Drive pivot — Phase 2

> The source corpus is the configured subtree of the one company Google Drive
> integration, not a per-user Docs Hub connection. See [Google Drive architecture](google-drive-architecture.md).

Phase 2 adds metadata-only Google Drive references to the existing Docs Hub
logical tree. Drive bytes remain in Google Drive; local uploads and ONLYOFFICE
continue using the existing `FileVersion` and storage flow.

## Logical backing

- `File.backingType` is `LOCAL` or `GOOGLE_DRIVE`.
- A Drive-backed `File` has exactly one unique `driveFileId`, no versions, and
  no storage object.
- A `DriveFile` can therefore be linked to at most one Docs Hub `Node`.
- `DriveFile.sourceStatus` is `CONNECTED`, `STALE`, or `UNAVAILABLE`.

## Organization API

- `POST /drive/files/:driveFileId/add-to-docshub` with `{ parentId }` creates a
  logical `FILE` node transactionally. `parentId: null` means the Docs Hub
  root; Google Drive is never mutated.
- `POST /nodes/:nodeId/move` moves a Drive-backed logical node by changing only
  `Node.parentId`.
- `DELETE /nodes/:nodeId/drive-reference` removes the logical Node/File
  reference while preserving the `DriveFile` metadata row.

All three operations use the account-level document-management gate: active
`ADMIN` and `DOCUMENT_MANAGER` users. `VIEWER` accounts remain read-only. No
Drive-specific per-file ACL is created.

## Account roles and authorization boundaries

Docs Hub now has three account-level roles:

- `ADMIN`: account administration plus all document-management operations.
- `DOCUMENT_MANAGER`: document creation, local file upload/Office creation,
  and logical organization of Drive references; no account administration.
- `VIEWER`: browse, search, recent/favorites, open, and preview according to
  the existing document visibility rules; no creation or organization.

The migration maps legacy `ADMIN` to `ADMIN` and legacy `MEMBER` to
`DOCUMENT_MANAGER`. New approved users default to `VIEWER`. The backend and
frontend use the same centralized policy predicates for view, document
management, and account administration; account status is checked separately.

The virtual Docs Hub root grants browse access to every active account. It
grants placement/create access only to `ADMIN` and `DOCUMENT_MANAGER`. Nested
local folders still honor the existing ACL and capability model, so Groups,
`PermissionEntry`, and the legacy share/permissions services remain in use
for `LOCAL` content. Local uploads, Office creation, and legacy local moves
therefore retain their existing ACL boundary.

Drive-backed references are metadata-only `Node`/`File` links. They do not
create `PermissionEntry` rows and do not expose the legacy Share/permissions
UI or APIs. Their visibility is the Docs Hub logical visibility (currently
general viewer access), while the source file's Google Drive permissions stay
authoritative in Google Drive. Active accounts browse the common synchronized
company corpus; only `ADMIN` and `DOCUMENT_MANAGER` can add, move, or remove a
Drive reference in Docs Hub.

## UI behavior

The connected Drive browser shows whether a file is already in Docs Hub and
offers a logical-folder picker for import. Docs Hub rows expose native Google
Docs/Sheets/Slides types, use Drive modified time, open through
`webViewLink`, and record the open in Recent. Removing a row is labelled
“Remove from Docs Hub” / “Gỡ khỏi Docs Hub”; it never trashes or deletes the
Google Drive file.
