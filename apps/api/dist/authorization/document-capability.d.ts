import { DocumentRole } from '@dochub/database';
export declare enum DocumentCapability {
    VIEW = "VIEW",
    PREVIEW = "PREVIEW",
    DOWNLOAD = "DOWNLOAD",
    CREATE = "CREATE",
    EDIT = "EDIT",
    RENAME = "RENAME",
    MOVE = "MOVE",
    DELETE = "DELETE",
    SHARE = "SHARE",
    MANAGE_PERMISSION = "MANAGE_PERMISSION",
    RESTORE_VERSION = "RESTORE_VERSION"
}
export declare const DOCUMENT_ROLE_CAPABILITIES: Readonly<Record<DocumentRole, readonly DocumentCapability[]>>;
