import type { StorageService } from '@dochub/storage';
import type { Response } from 'express';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { type ByteRange } from './byte-range.js';
export interface BinaryRead {
    stream: import('node:stream').Readable;
    version: {
        originalFilename: string;
        mimeType: string;
        sizeBytes: bigint;
    };
    totalSize: bigint;
    range: ByteRange | null;
}
export declare class FileReadService {
    private readonly database;
    private readonly authorization;
    private readonly storage;
    private readonly logger;
    constructor(database: DatabaseService, authorization: DocumentAuthorizationService, storage: StorageService);
    open(actorUserId: string, nodeId: string, capability: DocumentCapability.PREVIEW | DocumentCapability.DOWNLOAD, rangeHeader: string | undefined, versionId?: string): Promise<BinaryRead>;
    openAuthorized(nodeId: string, rangeHeader: string | undefined, versionId?: string): Promise<BinaryRead>;
    write(binary: BinaryRead, response: Response, attachment?: boolean): void;
}
