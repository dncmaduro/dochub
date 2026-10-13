# Docs Hub file, storage, and engine architecture

Status: canonical target architecture; Checkpoints 1 and 2 are implemented
(2026-10-12).

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

## File Engine boundary (implemented; Checkpoint 2)

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

The API now exposes a provider-neutral `FileDescriptor` with `fileId`,
`nodeId`, logical `name`, `mimeType`, `extension`, optional numeric `size`, and
an opaque `storageRef`. The only exception is the legacy local preview path,
which has no `StorageProvider` reference until that compatibility path is
migrated.

`FileEngineCapabilities` is currently:

```ts
{
  preview: boolean;
  edit: boolean;
  download: boolean;
  textExtraction: boolean;
  thumbnail: boolean;
}
```

`FileEngineRegistry` registers engines in an explicit priority order and
returns both the selected engine and its capabilities. A non-generic trusted
MIME type is matched first; only generic/absent MIME values use a controlled
extension fallback; otherwise `FallbackEngine` is selected. This makes a
Google-native MIME win over a misleading `.docx`, while an opaque
`application/octet-stream` may use `.docx` as a fallback.

The current engine identities are Document, Spreadsheet, Presentation, PDF,
Image, Text, Video, Audio, `LegacyGoogleNativeEngine`, and Fallback. All
physical engines depend only on `StorageProvider` through the engine runtime;
they do not import Drive services or provider error types. `edit`,
`textExtraction`, and `thumbnail` are reserved capability boundaries and are
false until real implementations exist.

The stable web-facing workspace preview descriptor is one of `pdf`, `image`,
`text`, `video`, `audio`, or `unavailable`. The web client renders this
descriptor and does not classify files by MIME or extension. The secure
`file-preview-session` endpoint returns the engine/capability metadata and
keeps the existing HttpOnly session cookie and opaque content URL.

Expected future capabilities include `load`, render-model construction,
`save`/`export`, `extractText`, and `generateThumbnail`.

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
engine. It is called behind the Document, Spreadsheet, and Presentation
engines through a provider-neutral runtime callback. The UI receives only a
PDF preview descriptor and never knows that LibreOffice was used. The API
temporary-directory conversion and Docker runtime packages may remain until
native engines exist.

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
| Preview | Existing secure local and Drive preview transports remain. | `FileEngineRegistry` resolves the engine/capabilities; physical preview uses `StorageProvider`, Drive export is legacy fallback only, and LibreOffice is behind office engines. | Checkpoint 2. |
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
| Primary activation | Drive-backed files now stay in Docs Hub preview modal; explicit Google action remains. | All normal activation calls the unified file-preview-session and renders its engine-neutral descriptor. | Checkpoint 2; explicit Google action remains compatibility-only. |
| Preview modal | Large Docs Hub modal supports direct previews and transitional Drive export/LibreOffice fallback. | Registry-selected renderer kind; no MIME/extension classification in React. | Checkpoint 2; native renderers later. |
| Create-new flow | Google-native Document/Spreadsheet/Presentation buttons previously called `/drive/documents`; those buttons are removed. | Future buttons create DOCX/XLSX/PPTX. | Future engine/create checkpoint. |
| Google-specific actions | `webViewLink` appears for explicit Open/Edit in Google and Drive import UI. | Explicit legacy action only; never default open path. | Checkpoint 1 response-model audit. |
| Product model leakage | `Node.backing` still exposes transitional Drive fields for import/legacy actions. | Engine descriptors do not include provider fields; broader Node response cleanup remains staged. | Checkpoint 2; later response-model cleanup. |

### Worker

| Area | Current | Target | Checkpoint to change |
|---|---|---|---|
| Extraction | `FileProcessingService` opens local `FileVersion.storageKey` and sends searchable MIME types to Tika. | FileEngine exposes an `extractText` hook; worker migration remains future work. | Checkpoint 2 reserves the hook; later worker/engine checkpoint. |
| Indexing | `SearchDocument` is tied to current local FileVersion and does not cover Drive-backed bytes. | Product content index is fed by File Engine output. | Later engine/search checkpoint. |
| Thumbnails | No native File Engine thumbnail implementation exists. | Registry/engine owns future thumbnail generation. | Checkpoint 2 reserves the capability; implementation later. |
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

## Checkpoint 2 implementation and boundary

Checkpoint 2 implements the File Engine framework and preview routing. The
registry and physical engines consume `StorageProvider.openRead()` and are
prepared for `StorageProvider.replace()`, but they do not import
`DriveService`, `GoogleDriveApiProvider`, Drive IDs, Drive export methods, or
Drive error types. `LegacyGoogleNativeEngine` is the isolated compatibility
exception: the Drive preview coordinator supplies a legacy PDF-export adapter
only for existing Google-native references.

No database engine table or schema migration was added. Authorization remains
the responsibility of the existing Docs Hub authorization services; engine
capabilities describe format support and are ANDed with user permissions by
the product flow.

## Checkpoint 3 — Document Engine V1: DOCX read/preview

Checkpoint 3 implements the native DOCX read path:

```text
FileWorkspacePreview
  -> DocumentEngine
  -> StorageProvider.openRead()
  -> bounded DOCX package reader/parser
  -> DocumentModel
  -> Docs Hub DocumentViewer
```

`DocumentModel` is provider-neutral and currently contains stable parser IDs
for paragraphs, headings, list items, tables/cells, images, text runs, and
safe unsupported-content placeholders. Paragraph runs preserve whitespace,
tabs, line breaks, direct formatting, common style inheritance, alignment,
spacing, indentation, and heading metadata. Numbering maps common decimal and
bullet `numId`/`ilvl` combinations to flat list items with nesting levels.
Tables retain rows, cells, nested blocks, basic borders/shading, and width
hints. Images resolve `document.xml` relationships to opaque, preview-session-
bound asset IDs; the browser never receives ZIP paths or provider credentials.
External hyperlinks are restricted to `http:`, `https:`, and `mailto:`.

The package reader uses in-memory ZIP entry access with limits of 50 MiB
compressed input, 100 MiB decompressed content, 25 MiB per entry, 10 MiB per
XML part, 2,000 entries, 256 media entries, and 50,000 document blocks. ZIP
paths are normalized and traversal/absolute paths are rejected. XML
validation and parsing do not resolve external entities. No package is
extracted to a filesystem directory, and parser diagnostics never log content,
raw XML, or credentials.

Native DOCX is the primary preview kind. Legacy DOC remains on the existing
LibreOffice PDF path. If a DOCX is malformed, unsupported by this parser, or
exceeds the bounded input/resource policy, the API records a safe diagnostic
and deliberately plans the existing LibreOffice PDF fallback; internal
programmer errors are not silently reclassified. XLS/XLSX, PPT/PPTX, PDF,
media, text, CSV, and unknown-file behavior remains on the Checkpoint 2
engine paths.

The model is delivered through the existing HttpOnly preview session as a
JSON model endpoint. Image assets are separately authenticated by that same
session. The frontend uses a focused `DocumentViewer` flow renderer with a
neutral document surface; it does not expose a Word ribbon, iframe Office UI,
Google editor, or ONLYOFFICE surface.

Checkpoint 3 is preview/read-only first. It does not add editing, save/export,
DOCX serialization, search-worker migration, or a new database model.

## Checkpoint 4 — Document Engine V1: native DOCX edit/save

Checkpoint 4 implements the bounded edit path:

```text
DOCX preview
  -> block-scoped Docs Hub editor
  -> typed semantic DocumentPatchRequest
  -> server editability/source-map validation
  -> narrow DOCX paragraph patch
  -> ZIP rebuild with original unrelated entry bytes
  -> StorageProvider.replace(expectedRevision)
  -> fresh parse and DocumentModel
```

The editor keeps `baselineModel`, `currentModel`, dirty block IDs, command
history, selection offsets, mode, and save status in a focused editor-state
module. Commands cover text replacement, bold/italic/underline/strike, font
size, alignment, and Normal/H1/H2/H3 style changes. Undo/redo is Docs Hub
command history; browser editing history is not authoritative. Editing is
block-scoped, uses plain-text textarea input for the active block, intercepts
structural browser behavior, and treats IME composition as a single semantic
text mutation. Rich pasted HTML and pasted images are not accepted.

The parser/source-map layer assigns deterministic structural block IDs for
body paragraphs and simple table-cell paragraphs. A paragraph is editable only
when its original source contains the controlled V1 subset (`w:p`, `w:pPr`,
`w:r`, `w:rPr`, `w:t`, `w:tab`, and `w:br`) with supported formatting and
paragraph properties. Hyperlinks, drawings/images mixed with text, fields,
tracked changes, content controls, equations, embedded objects, and unknown
significant OOXML keep their blocks read-only. Images, hyperlinks, unsupported
placeholders, list structure, table structure, and all structural block
insertion/deletion remain outside V1.

The save API is `PATCH /nodes/:nodeId/document`. It re-authorizes the caller
server-side, accepts only bounded typed semantic blocks, verifies the opaque
expected storage revision, reads the current DOCX through `StorageProvider`,
patches only changed safe paragraph source regions, and calls
`StorageProvider.replace()` on the same physical object. User text is escaped
by a controlled run serializer and `xml:space="preserve"` is added where
needed. The patcher never serializes the whole `document.xml`, and unrelated
parts such as styles, numbering, relationships, media, custom XML, and
unsupported OOXML are carried forward byte-for-byte before ZIP rebuilding.

Google Drive's current replace flow provides best-effort optimistic
concurrency (`stat` then patch then `replace`); it is not an atomic compare-
and-swap. A mismatch returns a provider-neutral conflict (HTTP 409), leaves
local edits intact, and offers reload after explicit discard confirmation.
Viewer saves are rejected by the existing Docs Hub authorization service.
DOC remains LibreOffice/PDF and is not editable. XLS remains a read-only
LibreOffice/PDF transitional fallback. PPTX remains on its existing preview
path.

## Checkpoint 5 — Spreadsheet Engine V1: native XLSX/CSV preview and save

Checkpoint 5 implements the native spreadsheet path:

```text
XLSX/CSV preview
  -> SpreadsheetEngine
  -> StorageProvider.openRead()
  -> bounded XLSX OOXML/CSV parser
  -> WorkbookModel + lazy SheetModel
  -> virtualized Docs Hub grid
  -> typed cell edits and undo/redo
  -> narrow worksheet patch or dialect-preserving CSV serialization
  -> StorageProvider.replace(expectedRevision)
  -> fresh authoritative model
```

`WorkbookModel` is provider-neutral. XLSX sheet IDs are deterministic opaque
session values derived from workbook relationship identity; the browser never
receives arbitrary ZIP paths. The workbook endpoint returns only a bounded
manifest (sheet names, visibility, dimensions, active sheet, formula and
unsupported-content indicators). The active sheet and later sheet tabs are
loaded through the authenticated preview-session-bound `/content/sheets/:sheetId`
endpoint. Sheet cells are sparse, and the browser renders only a viewport plus
overscan rows and columns.

Native V1 formats are XLSX and UTF-8 CSV (including controlled `.csv` fallback
when the source MIME is generic). XLS remains a read-only LibreOffice/PDF
fallback; no BIFF parser or writer is included. PPT remains transitional;
native PPTX is implemented in Checkpoint 6 below.

The XLSX parser reads workbook relationships, worksheets, shared strings,
styles, common number/date formats, row/column dimensions, merged ranges,
freeze-pane hints, formulas and cached values. Formula cells are visible but
read-only; Docs Hub does not calculate formulas. After scalar edits in a
formula-bearing workbook, formulas remain intact and workbook calculation
properties request recalculation on the next compatible office open. Cached
dependent values are marked as potentially stale; the Docs Hub grid never
claims to have recalculated them. Cell value editing preserves existing style
IDs. Merged ghost cells and unsupported special cells are read-only.

`PATCH /nodes/:nodeId/spreadsheet` accepts only a bounded semantic payload of
`{ expectedRevision, edits: [{ sheetId, cell, value }] }`. The endpoint
re-authorizes Docs Hub edit capability, validates sheet and cell identity,
rejects formulas and merged ghost cells, checks the provider revision, and
calls `StorageProvider.replace()`. A mismatch returns HTTP 409 and never
silently discards pending edits. Google Drive's current stat/replace sequence
remains a documented best-effort optimistic check rather than an atomic CAS.

`XlsxPatcher` changes only affected worksheet cell/value spans, creates a cell
or row in sorted order when needed, updates an existing dimension without
shrinking it, and uses inline strings for changed text cells. It rebuilds the
ZIP while carrying every untouched entry's original bytes forward. Styles,
shared strings, formulas, relationships, tables, drawings, charts, media,
custom XML, macros encountered in unsupported variants, and other unparsed
package parts are not reserialized. CSV parsing supports quoted commas,
embedded newlines, escaped quotes, Vietnamese UTF-8 text, detected delimiter,
and detected line ending; CSV save preserves that dialect and uses the same
semantic route.

The implementation bounds compressed/decompressed XLSX data, entry/XML size,
ZIP entries, shared strings, loaded cells, dimensions, merged ranges and edit
counts. CSV bytes, rows, columns and cells are bounded. ZIP paths reject
traversal/absolute names, XML parsing disables external entity behavior, and
untrusted client input cannot select raw XML or provider objects.

The small grid editor supports sheet switching, cell selection, arrows,
Tab/Enter navigation, blank-cell creation, scalar text/number/boolean edits,
clear, plain-text input, IME composition, Ctrl/Cmd+S, undo/redo, dirty state,
save failure retry, and conflict reload. It does not implement formula
evaluation, structural rows/columns/sheets operations, merge edits, filters,
sorting mutations, chart/table/pivot/drawing editing, or collaborative edits.

## Checkpoint 6 — Presentation Engine V1: native PPTX preview and basic edit/save

Checkpoint 6 adds the native Open XML presentation path:

```text
PPTX preview
  -> PresentationEngine
  -> StorageProvider.openRead()
  -> bounded PPTX package reader/parser
  -> PresentationModel manifest
  -> lazy SlideModel/image endpoints
  -> Docs Hub thumbnail rail + SlideCanvas
  -> typed semantic presentation commands
  -> narrow PptxPatcher
  -> StorageProvider.replace(expectedRevision)
  -> fresh authoritative manifest
```

`PresentationModel` contains slide dimensions and the source-order slide
manifest. `PresentationSlideModel` contains normalized slide-space geometry,
stable source-derived element IDs, semantic text paragraphs/runs, safe image
asset IDs, simple shape properties, z-order, and neutral unsupported-object
placeholders. Slides are loaded lazily through the authenticated preview
session; presentation assets are likewise served only through session-bound
opaque URLs. Slide dimensions come from `p:sldSz`, so 4:3, 16:9, and custom
aspect ratios are rendered without a hard-coded canvas ratio. The viewer
resolves presentation order from `presentation.xml` relationships rather than
slide filenames, and retains hidden-slide descriptors.

The native renderer is Docs Hub-owned DOM/CSS: positioned text, images, and
simple shapes inside a scaled slide coordinate space. It includes a scrollable
thumbnail rail, click navigation, basic zoom, hyperlinks restricted to
`http:`, `https:`, and `mailto:`, and placeholders for charts, SmartArt,
tables, and other unsupported objects. Common slide/layout/master/theme
context is inspected for basic placeholder geometry and theme font/color
fallbacks. This is an approximation of PowerPoint typography, not a
pixel-perfect Office renderer.

PPTX V1 editing is deliberately narrow. Safe text-bearing shapes expose
semantic text editing; simple text boxes, shapes, and images can expose move
and resize when their source transforms are unambiguous. Commands provide
undo/redo, dirty state, Ctrl/Cmd+S, and IME-safe textarea editing. There are
no slide insertion/deletion/reordering operations, element insertion/deletion,
chart/SmartArt/table-structure editing, master/layout/theme editing, notes
editing, animation/transition editing or playback, or native PPT binary
editing. PPT continues to use the existing LibreOffice/PDF read-only fallback.

`PATCH /nodes/:nodeId/presentation` accepts only bounded semantic
`PresentationPatchRequest` data containing slide/element IDs, changed text
paragraphs/runs, and changed geometry. The server re-authorizes the caller,
checks the opaque expected storage revision, validates source-derived
editability, patches only controlled `a:p` text and `a:xfrm` offset/extent
attributes, and replaces the original object through `StorageProvider`. It
does not rebuild a presentation from the model. Masters, layouts, themes,
media, relationships, notes, transitions/timing, chart/SmartArt parts,
hyperlinks, custom XML, and unrelated slide content are carried forward as
original ZIP entry bytes. A revision mismatch returns HTTP 409 and leaves
local dirty edits intact; the Drive stat/replace sequence remains the small
documented non-atomic optimistic-check window.

The PPTX reader bounds compressed/decompressed package bytes, entries, XML,
media, slides, elements, text, and patch size. ZIP traversal and absolute
paths are rejected, no package is extracted to disk, and malformed or
resource-exhausting native PPTX input is classified as unavailable rather
than falling through on internal programmer errors. The fixture and
round-trip tests cover ordered slides, dimensions, formatted text, bullets,
images, shapes, rotation, inheritance hints, unsupported content, safe
hyperlinks, geometry/text edits, revision conflicts, and byte-preserved
unrelated package parts.

## Checkpoint 7 — Other file engines and format normalization

Checkpoint 7 completes the first-class file-family matrix without changing the
StorageProvider boundary:

Upload acceptance is intentionally broader than preview/edit capability. The
active `/drive/uploads` ingress and the legacy local upload path accept any
non-empty, size-bounded file with a valid sanitized filename after
authorization, multipart, and storage checks. Known MIME values are
normalized (including common CSV, JSON, and image aliases); empty, generic, or
unrecognized MIME declarations are stored as `application/octet-stream` when
they are not reliable. The filename extension remains metadata for the
registry's controlled fallback and is never a product-level upload allowlist.
Unknown files are stored as opaque bytes, resolve to `FALLBACK`, expose no
preview/edit capability, and remain available through the authorized download
flow. Downloads use `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff`; SVG, HTML, and other active content are never rendered or
executed as trusted markup.

| Family | Engine | Preview | Edit | Product behavior |
| --- | --- | --- | --- | --- |
| DOCX | `DOCUMENT` | native | yes | native model/editor/save |
| DOC | `DOCUMENT` | PDF fallback | no | bounded LibreOffice conversion |
| XLSX / CSV | `SPREADSHEET` | native | yes | native model/editor/save |
| XLS | `SPREADSHEET` | PDF fallback | no | bounded LibreOffice conversion |
| PPTX | `PRESENTATION` | native | yes | native model/editor/save |
| PPT | `PRESENTATION` | PDF fallback | no | bounded LibreOffice conversion |
| TXT / Markdown / JSON / XML | `TEXT` | native | yes when within limits | shared source editor and format adapter |
| PDF | `PDF` | native browser PDF | no | authenticated same-origin stream |
| JPEG / PNG / WEBP / GIF | `IMAGE` | native image | no | fit/zoom viewer; animated GIF stays animated |
| MP4 / WebM | `VIDEO` | native media | no | controls and provider-backed ranges |
| explicit audio types | `AUDIO` | native media | no | browser controls; no transcoding |
| unknown | `FALLBACK` | unavailable | no | authorized download only |

TXT, Markdown, JSON, and XML share a bounded UTF-8 source layer. It accepts
valid UTF-8 with or without BOM, rejects invalid encodings instead of guessing
legacy encodings, records BOM and line-ending metadata, and preserves those
properties when saving where practical. The family is limited to 16 MiB input,
2 million decoded characters, 100,000 lines, and 8 MiB editable content. JSON
and XML structured validation additionally bounds depth to 100 and nodes to
50,000. Malformed JSON/XML remain available as source text, while their saves
are rejected until valid. XML parsing disables entity processing and rejects
DOCTYPE/external entity declarations; it never performs DTD, XInclude, network,
XSLT, or HTML execution.

The frontend uses one `TextFileEditor` foundation with format adapters: plain
text preserves whitespace and line breaks, Markdown renders a small safe
heading/list/quote/code/table/link subset with raw HTML disabled, JSON renders
bounded formatted source, and XML renders readable source. All rendered values
are React text/nodes; raw HTML is never injected. Markdown links are restricted
to `http:`, `https:`, and `mailto:` and open with `noopener noreferrer`; remote
Markdown images are not fetched. The source editor provides source/preview
modes, undo/redo, dirty state, save status, Ctrl/Cmd+S, IME-safe editing, and
revision conflict reload.

`PATCH /nodes/:nodeId/text` is the provider-neutral text save route. The server
re-authorizes edit access, resolves the real MIME/extension through
`FileEngineRegistry`, validates the bounded payload and actual text subtype,
checks the opaque storage revision, validates JSON/XML where applicable, and
calls `StorageProvider.replace()`. HTTP 409 never overwrites the provider and
keeps local text until the user explicitly reloads.

PDF, image, video, audio, and fallback behavior now use the same workspace
capability metadata and download action. PDF remains read-only and keeps the
authenticated same-origin/CSP/range path. Images are read-only and have a
small fit/zoom viewer; SVG is not added to the supported image set because it
would require an active-content sanitization policy. Video/audio MIME support
is explicit and range requests continue through `StorageProvider.openRead()`;
the browser is not asked to buffer the full object. Unknown files resolve to a
safe unavailable state with factual filename/type/size context and download
only when authorization permits.

Native text engines expose `extractText()`. Thumbnail capabilities remain false
unless an actual thumbnail implementation exists; no engine advertises a fake
thumbnail path. Legacy Google-native files remain isolated PDF-export
compatibility paths, while DOC/XLS/PPT remain read-only LibreOffice fallbacks.
No image, PDF, audio, video, legacy binary Office editing, or search-worker
migration was introduced.

## Checkpoint 8: save semantics, recovery, and history

Checkpoint 8 is implemented for the current native DOCX, XLSX/CSV, PPTX, and
text engines. The editor's explicit Save is the only operation that changes
the authoritative provider object. There is no provider autosave and no
periodic silent overwrite.

### Authoritative save protocol

Each native editor sends its opaque `expectedRevision` and an operation ID.
`FileSaveCoordinator` re-authorizes the file, reads the provider marker, and
stops with a structured conflict if the marker changed. The engine then
prepares bytes from the editor payload without mutating storage. The
coordinator preserves the old provider version, performs exactly one guarded
`StorageProvider.replace()`, preserves the resulting version, and finalizes
the product history row, audit record, outbox event, and idempotency record in
a serializable database transaction. A provider conflict is never retried as
an unconditional write. If finalization fails after the provider accepted the
bytes, the operation remains pending and the API returns a safe
"history finalization pending" response; it does not claim that the save is
fully complete.

`FileSaveOperation` is the write-ahead record for this boundary. Reusing the
same operation ID is idempotent after completion and is rejected while the
same operation is still being finalized. After the replacement revision is
preserved, the coordinator reads provider metadata again; the transaction,
response, and returned editor model all use that final storage revision rather
than the intermediate revision returned by the replace call. The browser
creates an operation ID for each explicit save request; a caller that retries a
request outside the browser can reuse the original ID.

### Provider-neutral product history

`FileRevision` is the product-owned history index. Its monotonic per-file
`sequence`, provider name, opaque provider version ID, storage revision,
source, actor, timestamp, byte size, and optional checksum are separate from
legacy local `FileVersion`. The current item is identified by the latest
sequence and the provider's current storage revision; historical bytes remain
in the provider. The API and UI expose the same list/download/restore shape
for Drive-backed history while retaining the legacy path for existing local
files.

For Google Drive, Docs Hub stores the Drive file `version` as the optimistic
storage marker and `headRevisionId` as the opaque historical revision handle.
Those values are intentionally not conflated: Google documents `version` as a
monotonically increasing server version, while `headRevisionId` identifies
the head revision for binary files. See Google's [file resource reference](https://developers.google.com/drive/api/v3/reference/files)
and [Manage revisions](https://developers.google.com/drive/api/v3/manage-revisions).

History retention is provider-aware. `FILE_VERSION_HISTORY_LIMIT` defaults to
50 and is bounded below the Drive keep-forever limit. Older product rows are
released from the provider before their index rows are removed; a failed
cleanup is logged and remains retryable. Permanent trash purge removes the
product history and save-operation rows after storage deletion and before the
file row, so restrictive foreign keys do not turn purge into a partial
database operation.

Restore is also an explicit guarded write. It requires the current revision
shown by the client, opens the selected provider version, preserves the
current version, replaces the current object once, preserves the new head,
and appends a `RESTORE` history row. Historical download reads the provider
version directly and never changes the current object.

### Local crash/navigation recovery

Recovery drafts are best-effort browser-local data in IndexedDB. They are
scoped by authenticated user, file, engine, base revision, and browser tab
session; they are not uploaded to the server and are removed on explicit
discard, successful save, or sign-out. Draft payloads are JSON-bounded to
512 KiB, retained for seven days, and capped at 20 drafts per user. Drafts
flush after a debounce and on visibility changes. The editor warns before
unload while dirty, and the workspace close action confirms before discarding.
IndexedDB is treated as sensitive local device storage; Docs Hub does not
claim that the browser encrypts it.

If the server revision changed, the draft is labeled as based on an older
revision. Restoring it keeps the source file protected by the normal 409
conflict guard; the user can review it and use Save as copy instead of
overwriting a newer source.

### Save as copy

Save as copy is a separate physical-object creation. It requires edit access
to the source and create access to the destination folder, derives the copy
from the editor's current dirty state, checks the destination name, uploads a
new provider object, and creates a new logical `Node`, `File`, `DriveFile`,
and initial `FileRevision`. It does not mutate the source, create a source
restore row, or silently rebase dirty edits over a newer source. If the source
advanced after the editor opened it, the coordinator reads the preserved
historical base revision and still creates the copy from that explicit editor
state.

### Deliberate boundaries

There is no cross-field merge UI, no automatic conflict overwrite, no server
autosave, and no claim that a browser-local draft is a backup. Provider
history remains subject to provider availability and provider retention rules;
when a historical version is unavailable, the API reports an unavailable
history/download result rather than substituting current bytes. Legacy local
FileVersion behavior remains intact for files that have not moved to the
provider-backed path.

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
