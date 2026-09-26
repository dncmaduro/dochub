import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { StorageService } from '@dochub/storage';
import { type TrashConfig } from './trash.config.js';
export declare class TrashService {
    private readonly database;
    private readonly authorization;
    private readonly storage;
    private readonly config;
    constructor(database: DatabaseService, authorization: DocumentAuthorizationService, storage: StorageService, config: TrashConfig);
    trash(actorId: string, nodeId: string): Promise<{
        operation: {
            id: string;
            rootNodeId: string;
            status: import("@dochub/database").$Enums.TrashOperationStatus;
            trashedAt: Date;
            expiresAt: Date;
        };
        affectedNodeCount: number;
    }>;
    private trashOnce;
    restore(actorId: string, operationId: string): Promise<{
        operation: {
            id: string;
            rootNodeId: string | null;
            status: import("@dochub/database").$Enums.TrashOperationStatus;
            restoredAt: Date | null;
        };
        restoredNodeCount: number;
    }>;
    purge(actorId: string, operationId: string): Promise<any>;
    private isSerializationConflict;
    private isOriginalParentAvailable;
}
