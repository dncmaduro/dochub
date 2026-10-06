import { DocumentRole, GeneralAccessRole } from '@dochub/database';

export enum DocumentCapability {
  VIEW = 'VIEW',
  PREVIEW = 'PREVIEW',
  DOWNLOAD = 'DOWNLOAD',
  CREATE = 'CREATE',
  EDIT = 'EDIT',
  RENAME = 'RENAME',
  MOVE = 'MOVE',
  DELETE = 'DELETE',
  SHARE = 'SHARE',
  MANAGE_PERMISSION = 'MANAGE_PERMISSION',
  RESTORE_VERSION = 'RESTORE_VERSION',
}

const viewerCapabilities = Object.freeze([
  DocumentCapability.VIEW,
  DocumentCapability.PREVIEW,
  DocumentCapability.DOWNLOAD,
]);

const editorCapabilities = Object.freeze([
  ...viewerCapabilities,
  DocumentCapability.CREATE,
  DocumentCapability.EDIT,
  DocumentCapability.RENAME,
  DocumentCapability.MOVE,
  DocumentCapability.DELETE,
  DocumentCapability.RESTORE_VERSION,
]);

const ownerCapabilities = Object.freeze([
  ...editorCapabilities,
  DocumentCapability.SHARE,
  DocumentCapability.MANAGE_PERMISSION,
]);

/** The single source of truth for document-role capabilities. */
export const DOCUMENT_ROLE_CAPABILITIES: Readonly<
  Record<DocumentRole, readonly DocumentCapability[]>
> = Object.freeze({
  [DocumentRole.VIEWER]: viewerCapabilities,
  [DocumentRole.EDITOR]: editorCapabilities,
  [DocumentRole.OWNER]: ownerCapabilities,
});

/** Capabilities granted by a node's link/general-access policy. */
export function generalAccessCapabilities(
  role: GeneralAccessRole | undefined,
): Set<DocumentCapability> {
  const capabilities = new Set<DocumentCapability>();
  if (role === GeneralAccessRole.VIEWER || role === GeneralAccessRole.EDITOR) {
    capabilities.add(DocumentCapability.VIEW);
    capabilities.add(DocumentCapability.PREVIEW);
  }
  if (role === GeneralAccessRole.EDITOR) {
    capabilities.add(DocumentCapability.EDIT);
  }
  return capabilities;
}
