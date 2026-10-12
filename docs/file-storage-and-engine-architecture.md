# Docs Hub file, storage, and engine architecture

Status: canonical target architecture for Checkpoint 0 (2026-10-11).

This document is the product and implementation boundary for the storage and
file-engine work. The `docs/google-drive-phase-*.md` files describe historical
delivery phases; they are retained for migration context and are not the
current product contract. The Google-specific implementation notes in
[`google-drive-architecture.md`](google-drive-architecture.md) are subordinate
to this document.

## Decision summary

Docs Hub is a document-management product, not a frontend for Google Drive or
Google Workspace. Docs Hub owns the logical file tree, upload and ingest,
preview, future editing, search, Recent, Favorites, metadata, permissions,
workflows, and file-type engines.

Google Drive is the current private physical storage backend. It is
conceptually equivalent to S3, MinIO, or another object store. Users should
not need to know which backend contains the bytes.

The key invariant is:

```text
Google Drive physical hierarchy != Docs Hub logical hierarchy
```

`Node.parentId` is the user-visible hierarchy. A Drive folder, Drive parent
ID, or Drive browser location must never become the product's folder model.
The configured Drive storage folder is a private object-storage root, not a
corpus that users browse as the primary product experience.

## Product responsibilities

Docs Hub is responsible for:

- logical folders and file nodes;
- upload-first ingest from a user's computer;
- file names, extensions, MIME metadata, size, timestamps, and product state;
- preview and future viewer/editor UX inside Docs Hub;
- Docs Hub authorization, sharing, Recent, Favorites, trash, and workflows;
- file-engine selection, rendering, editing, extraction, thumbnails, and
  conflict handling.

The storage backend is responsible for durable bytes and backend-native object
operations. A backend's object ID, revision token, folder/layout, export API,
and credentials are implementation details.

## Logical and physical models

The target conceptual model is:

```text
Node
  logical hierarchy and display name
  FILE or FOLDER type
  Docs Hub metadata and authorization relationship

File
  belongs to one FILE Node
  logical file identity
  MIME type, extension, size, checksum
  storage object reference
  timestamps and revision marker
  future File Engine metadata

StoredObject
  provider
  providerObjectId (opaque)
  provider revision/version metadata
  size/checksum where available
```

For the current Drive-backed rows, the opaque reference is represented by the
existing `DriveFile`/`driveFileId` structures. The product layer must
eventually consume a provider-neutral reference such as:

```text
File
  id
  nodeId
  storageProvider = GOOGLE_DRIVE
  storageObjectId = <opaque provider object ID>
  mimeType
  extension
  size
  storageRevision
```

The eventual equivalent of `storageObjectId` may be a Drive file ID, S3 key,
MinIO object key, or local object ID. It is not a user-visible folder path.

### Current database assessment

- `Node` already provides the correct logical hierarchy through `parentId`.
- `File` currently has two backing modes: `LOCAL` and `GOOGLE_DRIVE`.
- `DriveFile` is a Drive-specific metadata catalog and opaque external
  reference, but its fields are exposed into product response shapes.
- `FileVersion` plus `storageKey` is the legacy local-byte/version model. It
  remains necessary for existing local files, historical versions, restore,
  migration, and compatibility. It must not become the new primary authority.
- `GoogleDriveIntegration` is the current company storage integration and
  configured storage-folder record. Its OAuth and folder fields are provider
  concerns.
- `DriveUploadOperation`, `DriveCreationOperation`, and
  `DriveFileMigration` are staged operation/migration records. Do not drop
  them in Checkpoint 0.
- `EditorSession` and its historical migrations remain compatibility records.
  They are not active runtime authority and must not be restored as the
  editing model.

No destructive Prisma migration is part of this checkpoint.

## Ingest and creation direction

### Upload is the primary ingest flow

The target flow is:

```text
computer file
  -> Docs Hub upload API
  -> StorageProvider.put(...)
  -> logical Node + File metadata transaction
  -> file appears under the selected Docs Hub Node.parentId
```

The upload request accepts a logical Docs Hub `parentId`; it must not accept a
Drive parent ID as the product destination. The provider chooses the physical
storage location.

The current `/drive/uploads` path already follows this shape for Drive-backed
uploads and is the principal current ingest path. Its Drive-specific transfer
and registration code is a Checkpoint 1 extraction target.

“Add from Google Drive” remains a transitional import utility. It may be kept
for legacy references and optional future import, but it must not define the
storage abstraction or the primary product workflow. The current Drive
browser/import surface is intentionally not redesigned in Checkpoint 0.

### Future create behavior

When native Docs Hub creation is implemented, it will create physical files:

- New Document -> `.docx`;
- New Spreadsheet -> `.xlsx`;
- New Presentation -> `.pptx`;
- table/data creation may use `.csv` where appropriate.

Docs Hub must not create Google-native MIME types for new product content:

```text
application/vnd.google-apps.document
application/vnd.google-apps.spreadsheet
application/vnd.google-apps.presentation
```

The normal web Create new dialog no longer calls the legacy Google-native
creation route. The backend route, operation model, and tests remain
temporarily for staged removal and historical reconciliation. This checkpoint
does not implement `.docx`, `.xlsx`, or `.pptx` creation.

## Google-native files and Drive import

Existing Google Docs, Sheets, and Slides references are legacy/transitional
content. They are not converted or deleted in this checkpoint. A later,
explicit migration may export them to DOCX/XLSX/PPTX, validate the resulting
bytes, and register those bytes through `StorageProvider`.

The intended later migration is:

```text
Google Doc   -> export DOCX -> provider-backed physical file
Google Sheet -> export XLSX -> provider-backed physical file
Google Slide -> export PPTX -> provider-backed physical file
```

No mass conversion, production Drive mutation, bulk rename, or destructive
reorganization is allowed here.

`webViewLink` and `files.export` are not normal product-open mechanisms. During
the transition, Drive PDF export may remain the preview fallback for existing
Google-native files, and an explicit “Edit in Google” action may remain for
legacy Google-native content. Normal activation stays in Docs Hub.

## StorageProvider boundary (implemented; Checkpoint 1)

Checkpoint 1 implements the physical-object boundary in the API storage
module. The contract is streaming-first and deliberately does not expose
Drive folders, `webViewLink`, native editing, or Express request/response
objects:

```ts
interface StorageProvider {
  put(input: PutObjectInput): Promise<StoredObject>;
  openRead(reference: StorageReference, options?: ReadOptions): Promise<StorageReadResult>;
  replace(reference: StorageReference, input: ReplaceObjectInput, precondition?: ReplacePrecondition): Promise<StoredObject>;
  delete(reference: StorageReference): Promise<void>;
  stat(reference: StorageReference): Promise<StoredObjectMetadata>;
}
```

The implemented reference is `{ provider: "GOOGLE_DRIVE", objectId }`. Metadata
contains the provider, opaque object ID, MIME type, byte size, optional MD5
checksum, optional modification time, and optional revision. For Google Drive,
`revision` is the Drive API `version` field returned by `files.get`/upload
responses; it is not a Docs Hub version number. New uploads use a UUID plus the
validated extension as their physical name and always use the configured
`storageFolderId` as their physical parent. `Node.parentId` is never passed to
Drive as a parent, and the logical `Node.name` remains authoritative for the
user-visible filename.

`GoogleDriveStorageProvider` owns the provider mapping for put/read/range-read/
replace/delete/stat and maps raw Drive failures to provider-neutral storage
errors. It reuses `DriveService`'s existing company-integration token refresh
path; credentials and refresh tokens do not enter product services or the
frontend. Ordinary upload, preview, Office fallback conversion input, and
Drive-backed content/download reads use this boundary. The Google-native PDF
export route remains a deliberately isolated legacy exception because native
Google files do not expose ordinary binary media bytes.

`replace()` preserves the Drive file ID. It checks `expectedRevision` with a
fresh `files.get` before the resumable `files.update` upload. The current Drive
API path and scopes do not provide an atomic revision precondition in the
adapter, so this is a best-effort optimistic check with a documented race
window; callers must not treat it as an atomic compare-and-swap. A later
checkpoint can add a provider-specific atomic primitive if the selected API
supports one without breaking the provider-neutral method shape.

The database compromise is intentionally retained: `File.driveFileId` still
points to the existing `DriveFile` catalog row, and `DriveFile` still stores
transitional Drive fields such as `webViewLink`, physical parents, and native
type. New provider-backed uploads populate only storage-relevant metadata plus
safe neutral defaults for those legacy columns; no destructive schema cleanup,
mass rename, or physical reorganization is performed in this checkpoint.

`StorageProvider.delete()` is an explicit physical lifecycle operation. The
Docs Hub operations that move, rename, reorganize, trash, or unlink a logical
Node do not call it. The upload compensation path may call it after a remote
object was created but registration failed; broader retention/purge policy is
still a later lifecycle checkpoint.

The existing `@dochub/storage` `StorageService`/`LocalFileStorage` is a useful
legacy local-byte abstraction, but it is not the final provider boundary. Do
not make local filesystem bytes the new source of truth.

## File Engine boundary (future; not implemented)

The UI should ask a registry what a file can do rather than maintain large
MIME/extension conditionals:

```text
FileEngineRegistry
├── DocumentEngine       DOC/DOCX
├── SpreadsheetEngine    XLS/XLSX/CSV
├── PresentationEngine   PPT/PPTX
├── PdfEngine             PDF
├── ImageEngine           images
├── TextEngine            TXT/Markdown/JSON/XML
├── VideoEngine           video
├── AudioEngine           audio
└── fallback
```

Expected capabilities include `canPreview`, `canEdit`, `load`, render-model
construction, `save`/`export`, `extractText`, and `generateThumbnail`.

Complex packages are not edited directly by UI code. The future boundaries are
for example:

```text
DOCX/OOXML -> DocumentModel -> Docs Hub renderer/editor
XLSX/OOXML -> WorkbookModel  -> grid/editor
PPTX/OOXML -> PresentationModel -> slide renderer/editor
```

Saving uses an internal model plus the original package where appropriate,
then exports/patches and calls `StorageProvider.replace()`.

## Viewer, editor, and preview ownership

The intended UX is:

```text
click file
  -> large Docs Hub FileWorkspaceModal / Preview modal
  -> Docs Hub renderer
  -> Edit switches the same workspace into Docs Hub edit mode
```

Docs Hub owns the future viewer/editor. A file without a native editor remains
read-only preview, fallback preview, or download. The UI must not claim edit
capability that the selected engine does not provide.

The current preview work is transitional and intentionally retained:

- direct PDF, image, text, and video previews remain in Docs Hub;
- existing Google-native files may use Drive PDF export;
- Office files may use request-scoped headless LibreOffice conversion to PDF.

LibreOffice is a **transitional fallback preview**, not the future file
engine. It must not become the internal document model, editing architecture,
or long-term renderer. The API temporary-directory conversion and Docker
runtime packages may remain until native engines exist.

ONLYOFFICE remains removed from active runtime. Do not restore its service,
DocsAPI, DocEditor, editor sessions, callbacks, document keys,
`office.docshub.space`, port 8082, environment variables, or CSP origins.
Historical `EditorSession` schema/migrations may remain temporarily.

## Permissions

Docs Hub authorization is the product-level access authority. Users interact
through Docs Hub capabilities, folder permissions, sharing, and workflows.
The company Google account and Drive credentials are infrastructure used by
the storage provider; normal access must not depend on each end user's Drive
permissions.

The existing permission model and Drive ACL behavior are not rewritten in this
checkpoint. The audit target is every place where a Drive permission or
`webViewLink` assumption leaks into product logic. Checkpoint 1 should preserve
Docs Hub authorization while moving backend access behind the provider.

## Search, indexing, thumbnails, and workers

Search must eventually use File Engine extraction, not Drive metadata/search:

```text
DOCX -> paragraphs/text
XLSX -> sheet/cell text
PPTX -> slide text
PDF  -> extracted text
```

The current worker indexes local `FileVersion` bytes through the local storage
service and Apache Tika. Drive-backed files currently have name/metadata
search but are not content-indexed by the worker. This is transitional; do not
implement File Engine extraction in Checkpoint 0.

The same future engine boundary should own thumbnail generation. Current
worker extraction/indexing and any future thumbnail work must consume a
provider-neutral readable object and file metadata, not Drive API types.

## Save, conflict, and version direction

Future edits should load a logical File and an opaque storage revision. A save
must use conditional replacement against the expected revision. On a revision
conflict, Docs Hub should preserve both the user's work and the newer stored
state according to a later conflict policy; it must not silently overwrite
bytes.

The eventual version strategy should separate:

- Docs Hub logical file identity and user-visible version history;
- provider object identity and provider revision/version metadata;
- immutable or safely replaceable physical objects;
- checksum/size verification and audit events.

The old local `FileVersion` model can inform this design, but it is not to be
reintroduced as the primary byte authority. The precise version table and
conflict workflow belong to later checkpoints.

## Codebase delta map

The following is the implementation basis for Checkpoint 1. “Checkpoint 0”
means audit/documentation or the small safe cleanup already performed.

### Database

| Area | Current | Target | Checkpoint to change |
|---|---|---|---|
| `Node` | Logical tree through `parentId`; already product-facing. | Remains the only user-visible hierarchy. | Keep in Checkpoint 1; remove provider leakage from response assembly over time. |
| `File` | `LOCAL` or `GOOGLE_DRIVE`; Drive relation is optional and provider-shaped. | Logical File points to an opaque StoredObject reference. | Checkpoint 1 adapter/read path; staged schema work later. |
| `DriveFile` | Drive metadata catalog with `driveFileId`, `webViewLink`, Drive parents, timestamps, and native type. | Storage-provider implementation/migration record, not a general product model. | Keep schema; move reads behind provider-facing mapping in Checkpoint 1/2. |
| `FileVersion` | Local `storageKey`/bytes, current-version pointer, search/index relation. | Compatibility archive plus future logical version metadata; not local-byte authority. | Keep rows; define migration mapping after provider boundary. |
| `GoogleDriveIntegration` | Company OAuth credentials, scopes, storage folder, sync state. | GoogleDriveStorageProvider configuration and credential state. | Checkpoint 1 provider owns access; no destructive migration. |
| `DriveUploadOperation` | Idempotent Drive upload/register operation. | Provider-neutral ingest operation, or Drive-specific implementation record. | Checkpoint 1 isolate Drive details. |
| `DriveCreationOperation` | Idempotent Google-native creation operation. | Retire after DOCX/XLSX/PPTX creation exists. | Retain; no new UI use in Checkpoint 0. |
| `EditorSession` | Historical local/ONLYOFFICE-era schema. | Compatibility only; never active authority. | Retain; later cleanup decision. |

### API

| Area | Current | Target | Checkpoint to change |
|---|---|---|---|
| Upload | `/drive/uploads` streams bytes directly through `DriveService`/Google provider and registers a Drive-backed File. `/files` is legacy local upload. | Upload API accepts logical parent and calls `StorageProvider.put`. | Checkpoint 1. |
| Drive provider | `GoogleDriveApiProvider` owns OAuth, Drive HTTP, IDs, parents, export, upload, and delete. | `GoogleDriveStorageProvider` is the only Drive API consumer. | Checkpoint 1. |
| Drive browser/import | `/drive/browser/files` plus `DriveOrganizationService` adds metadata-only references. | Optional transitional import utility, outside core ingest. | Audit in Checkpoint 0; isolate/deprioritize in later checkpoint. |
| Preview | `DrivePreviewService` branches on Drive MIME, export, and LibreOffice fallback; local preview reads `FileVersion`. | Preview service asks File Engine/StorageProvider; Drive export is legacy fallback only. | Checkpoint 1 provider read boundary; File Engine later. |
| Create document/spreadsheet/presentation | `/drive/documents` creates Google-native files; web path removed. | Create real DOCX/XLSX/PPTX through future engines. | Backend retained transitional; implementation later. |
| Download | Local `FileReadService` reads local storage; Drive-backed download routes through Drive-specific service. | Authorization + StorageProvider openRead, with product-neutral metadata. | Checkpoint 1. |
| Delete/trash | Docs Hub trash controls Nodes; Drive reference removal can delete only logical reference, while provider operations remain Drive-specific. | Product trash and provider object lifecycle explicitly separated. | Checkpoint 1 audit; later lifecycle policy. |
| Search | Name search covers Nodes; content search is local `SearchDocument`/FileVersion only. | File Engine extraction feeds product index; Drive metadata search is not authority. | Worker/engine later; provider neutrality in Checkpoint 1. |
| Permissions | Docs Hub capability checks exist, but Drive links/ACL language leaks into product responses and explicit Google actions. | Docs Hub authorization controls normal access; provider credentials are infrastructure. | Checkpoint 1 audit and mapping. |

### Web

| Area | Current | Target | Checkpoint to change |
|---|---|---|---|
| Add from | Sidebar menu exposes “Add from Google Drive” and a Create new dialog. | Upload is primary; Drive import is visibly transitional/optional. | Native Google create UI removed in Checkpoint 0; import redesign later. |
| Upload | Page and menu upload call `/drive/uploads`; availability is tied to Drive integration/write state. | Upload is the primary product flow and should not expose provider choice. | Checkpoint 1 API client/provider boundary. |
| Primary activation | Drive-backed files now stay in Docs Hub preview modal; explicit Google action remains. | All normal activation stays in FileWorkspaceModal. | Preserve current preview work; engine later. |
| Preview modal | Large Docs Hub modal supports direct previews and transitional Drive export/LibreOffice fallback. | Registry-selected renderer/model. | Preserve in Checkpoint 0; engine later. |
| Create-new flow | Google-native Document/Spreadsheet/Presentation buttons previously called `/drive/documents`; those buttons are removed. | Future buttons create DOCX/XLSX/PPTX. | Future engine/create checkpoint. |
| Google-specific actions | `webViewLink` appears for explicit Open/Edit in Google and Drive import UI. | Explicit legacy action only; never default open path. | Checkpoint 1 response-model audit. |
| Product model leakage | `Node.backing` exposes Drive IDs, links, normalized Drive type, and Drive time. | UI consumes provider-neutral capabilities/metadata. | Checkpoint 1/2. |

### Worker

| Area | Current | Target | Checkpoint to change |
|---|---|---|---|
| Extraction | `FileProcessingService` opens local `FileVersion.storageKey` and sends searchable MIME types to Tika. | File Engine extracts from `StorageProvider.openRead` for any supported physical file. | Provider-neutral read contract in Checkpoint 1; engines later. |
| Indexing | `SearchDocument` is tied to current local FileVersion and does not cover Drive-backed bytes. | Product content index is fed by File Engine output. | Later engine/search checkpoint. |
| Thumbnails | No native File Engine thumbnail boundary exists. | Registry/engine owns thumbnail generation. | Later engine checkpoint. |
| Retention | Local storage/trash retention services remain. | Retention coordinates logical trash and provider deletion safely. | Checkpoint 1/2 lifecycle audit. |

### Infrastructure

| Area | Current | Target | Checkpoint to change |
|---|---|---|---|
| Drive OAuth/service credentials | API stores encrypted company Drive token material and uses configured OAuth env vars. | Credentials are private provider infrastructure, never product identity. | Checkpoint 1 provider extraction; keep secret handling. |
| Storage folder | Configured Drive folder is used as physical parent for uploads/native creation/migration. | Private opaque object-storage root; generated object names are allowed for new files. | Checkpoint 0 documents; no destructive reorganization. |
| LibreOffice fallback | API image includes Writer/Calc/Impress and converts Office files to temporary PDFs. | Transitional fallback only, removable after native engines. | Retain current uncommitted preview work. |
| Docker runtime | API has LibreOffice; worker has Tika and local storage mount. | Runtime supports provider and engine workers without coupling business code to Drive/local paths. | Audit in Checkpoint 1; no invented Docker redesign now. |
| Local storage | `/data/storage` and `StorageService` support legacy local versions. | Compatibility/migration storage only unless a future provider explicitly uses it. | Do not make it source of truth. |

## Safe cleanup performed in Checkpoint 0

- Removed Google-native Document/Spreadsheet/Presentation actions from the
  normal web Create new dialog.
- Removed the unused web API client method and types for that normal UI path.
- Added an explicit legacy comment to the backend Google-native creation route;
  its database records, provider method, and tests remain staged.
- Preserved the existing Docs Hub preview-modal work, including Drive PDF
  export and LibreOffice fallback preview.
- Did not change production Drive objects, migrate schema, rename/move existing
  files, restore ONLYOFFICE, or implement FileEngine.

## Checkpoint 1 contract

Checkpoint 1 implements the StorageProvider abstraction only:

1. define provider-neutral object/reference/stat/read types;
2. define `put`, `openRead`, `replace`, `delete`, and `stat` semantics;
3. implement `GoogleDriveStorageProvider` using the current company
   integration and private storage folder;
4. move upload/download/replace/delete reads behind the abstraction;
5. keep `Node.parentId` as the logical destination;
6. preserve Docs Hub authorization and staged legacy records;
7. avoid File Engine implementation, mass Google-native conversion, and
   destructive schema cleanup.

The success criterion is that business and future file-engine code no longer
needs to know whether `storageObjectId` is a Google Drive ID, an S3 key, a
MinIO key, or a local object ID.

## Checkpoint 2 boundary

Checkpoint 2 is the File Engine framework. It may consume
`StorageProvider.openRead()` and `StorageProvider.replace()` plus normalized
metadata, but it must not import `DriveService`, `GoogleDriveApiProvider`,
Drive IDs, Drive export methods, or Drive error types. It is intentionally not
implemented here.

## ADR: Google Drive is an opaque storage backend

### Context

Earlier phases treated Google Drive as a browsable source corpus and created
Google-native Docs, Sheets, and Slides. That couples product hierarchy,
editing, permissions, and search to Google-specific concepts.

### Decision

Google Drive is an opaque physical storage backend for Docs Hub. Docs Hub's
logical `Node` tree, product authorization, upload flow, viewer/editor UX,
and file engines are the product authority. Physical Drive hierarchy, IDs,
native MIME types, export APIs, and links stay behind provider or transitional
import boundaries.

### Consequences

Users organize and open files in Docs Hub. Upload becomes primary. New native
Docs Hub content will be DOCX/XLSX/PPTX. Google-native files, Drive browser,
Drive export, explicit Google editing, and LibreOffice conversion are legacy
or transitional capabilities. Search and editing must eventually be built on
File Engines rather than Google editors or Drive metadata.

### Migration implications

Checkpoint 1 introduces StorageProvider. Later checkpoints map existing
DriveFile/local-version rows to opaque StoredObject references, add File Engine
registries and internal models, export legacy Google-native files when
explicitly approved, and remove obsolete native-creation/import paths only
after data and user workflows are safely migrated.
