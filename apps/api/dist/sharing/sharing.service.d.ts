import { type AuthConfig } from '../auth/auth.config.js';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import { UpdateSharingDto } from './dto/update-sharing.dto.js';
import type { ShareLinkResponse, SharingState } from './sharing.types.js';
export declare class SharingService {
    private readonly database;
    private readonly authorization;
    private readonly config;
    constructor(database: DatabaseService, authorization: DocumentAuthorizationService, config: AuthConfig);
    getState(actorId: string, nodeId: string): Promise<SharingState>;
    ensureLink(actorId: string, nodeId: string): Promise<ShareLinkResponse>;
    resetLink(actorId: string, nodeId: string): Promise<ShareLinkResponse>;
    revokeLink(actorId: string, nodeId: string): Promise<void>;
    updatePublicAccess(actorId: string, nodeId: string, dto: UpdateSharingDto): Promise<{
        nodeId: string;
        publicAccess: boolean;
    }>;
    private requireNode;
    private activeLink;
    private createLink;
    private audit;
    private withSerializableRetry;
    private isRetryable;
}
