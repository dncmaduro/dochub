# Google Drive Phase 1

Docs Hub's Drive integration is intentionally separate from Google sign-in.
The existing Google OIDC login continues to request only `openid email profile`
and only establishes the Docs Hub session. The Profile page starts a second,
PKCE-protected OAuth flow for Drive.

## Scope and discovery boundary

Phase 1 requests exactly:

`https://www.googleapis.com/auth/drive.metadata.readonly`

This is sufficient to list files and read metadata, including native Google
Docs, Sheets, and Slides MIME types. The sync requests metadata fields only;
it never calls a download/export endpoint. The initial sync includes the user's
Drive corpus with `includeItemsFromAllDrives=true`, and separately enumerates
Shared Drives with `corpora=drive`. `sharedWithMeTime` and `driveId` are kept as
location metadata so My Drive, Shared with me, and Shared Drive results are not
silently treated as the same location.

## Storage boundary

`DriveConnection` stores encrypted OAuth token material and sync state.
`DriveFile` stores the external Drive file ID, metadata, normalized type, and
links. The unique identity is `(driveConnectionId, driveFileId)`. Drive files
are not inserted into `Node`, `File`, or `FileVersion`, and no StorageService or
ONLYOFFICE session is involved.

## Configuration

Set `DRIVE_TOKEN_ENCRYPTION_KEY` to a distinct high-entropy secret of at least
32 characters. The Drive callback URI is derived from `GOOGLE_REDIRECT_URI` by
replacing `/auth/google/callback` with `/drive/connection/callback`, unless
`GOOGLE_DRIVE_REDIRECT_URI` is set explicitly. Register the exact resulting URI
in Google Cloud Console. `DRIVE_CONNECT_SUCCESS_REDIRECT_URL` is optional and
defaults to the configured web origin's `/profile` page.

## Out of scope

Phase 1 does not import files into the Docs Hub node tree, download bytes,
create or mutate Drive files, use the Changes API or webhooks, or manage Drive
permissions.
