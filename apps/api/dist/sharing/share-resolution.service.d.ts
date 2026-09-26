import { NodeType } from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';
export interface ResolvedShareLink {
    node: {
        id: string;
        type: NodeType;
        name: string;
    };
    mode: 'AUTHENTICATED' | 'PUBLIC';
    capabilities: ReadonlySet<DocumentCapability>;
}
export declare class ShareResolutionService {
    private readonly database;
    private readonly authorization;
    constructor(database: DatabaseService, authorization: DocumentAuthorizationService);
    resolve(token: string, auth: AuthPrincipal | undefined, capability: DocumentCapability): Promise<ResolvedShareLink>;
    private assertActiveChain;
}
