import { NodeType } from '@dochub/database';
import type { StorageService } from '@dochub/storage';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { FileValidationService } from './file-validation.service.js';
import type { TempUpload } from './file-upload.types.js';
export interface UploadResponse {
    node: {
        id: string;
        parentId: string | null;
        type: NodeType;
        name: string;
        createdAt: Date;
        updatedAt: Date;
        capabilities: DocumentCapability[];
    };
    file: {
        id: string;
        currentVersionId: string;
    };
    version: {
        id: string;
        versionNumber: number;
        originalFilename: string;
        mimeType: string;
        extension: string | null;
        sizeBytes: string;
        sha256: string;
        createdAt: Date;
    };
}
export declare class FilesService {
    private readonly database;
    private readonly authorization;
    private readonly validation;
    private readonly storage;
    private readonly logger;
    constructor(database: DatabaseService, authorization: DocumentAuthorizationService, validation: FileValidationService, storage: StorageService);
    createInitial(actorUserId: string, upload: TempUpload): Promise<UploadResponse>;
    createVersion(actorUserId: string, nodeId: string, upload: TempUpload): Promise<UploadResponse>;
    private assertInitialDestination;
    private requireEditableFile;
    private requireVisibleNode;
    private requireCapability;
    private storageKey;
    private response;
    private writeAudit;
    private createTextExtractionTask;
    private deleteOrphan;
    private throwDomainConflict;
    private assertUuid;
}
