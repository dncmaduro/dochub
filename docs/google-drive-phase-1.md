# Google Drive Phase 1

> Architecture correction: Docs Hub uses one company-wide Shared Drive and
> one `GoogleDriveIntegration`. See [Google Drive architecture](google-drive-architecture.md).

Docs Hub's Drive integration is intentionally separate from Google sign-in.
The existing Google OIDC login continues to request only `openid email profile`
and only establishes the Docs Hub session. Only an administrator starts the
second, PKCE-protected OAuth flow for the company integration; Profile does
not configure Drive.

## Scope and discovery boundary

Phase 1 requests exactly:

`https://www.googleapis.com/auth/drive.metadata.readonly`

This is sufficient to list files and read metadata, including native Google
Docs, Sheets, and Slides MIME types. The sync requests metadata fields only;
it never calls a download/export endpoint. The initial sync includes the
configured company Shared Drive with `includeItemsFromAllDrives=true`,
`supportsAllDrives=true`, `corpora=drive`, and `driveId`. It does not enumerate
a user's My Drive or `sharedWithMe`.

## Storage boundary

`GoogleDriveIntegration` stores encrypted OAuth token material, Shared Drive
target, and sync state. `DriveFile` stores the external Drive file ID,
metadata, normalized type, and links. The unique identity is `driveFileId`.
Legacy `DriveConnection` rows are retained only for safe transition. Drive files
are not inserted into `Node`, `File`, or `FileVersion`, and no StorageService or
ONLYOFFICE session is involved.

## Configuration

Set `DRIVE_TOKEN_ENCRYPTION_KEY` to a distinct high-entropy secret of at least
32 characters. The Drive callback URI is derived from `GOOGLE_REDIRECT_URI` by
replacing `/auth/google/callback` with `/drive/integration/callback`, unless
`GOOGLE_DRIVE_REDIRECT_URI` is set explicitly. Register the exact resulting URI
in Google Cloud Console. `DRIVE_CONNECT_SUCCESS_REDIRECT_URL` is optional and
defaults to the Admin page.

## Out of scope

Phase 1 does not import files into the Docs Hub node tree, download bytes,
create or mutate Drive files, use the Changes API or webhooks, or manage Drive
permissions.
