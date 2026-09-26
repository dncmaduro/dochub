import { Prisma, type PrismaClient } from '@dochub/database';
import { DatabaseService } from '../database/database.service.js';
import { DocumentCapability } from './document-capability.js';
export interface ResolvedDocumentCapabilities {
    nodeId: string;
    capabilities: ReadonlySet<DocumentCapability>;
}
export type DocumentAuthorizationClient = PrismaClient | Prisma.TransactionClient;
export declare class DocumentAuthorizationService {
    private readonly database;
    constructor(database: DatabaseService);
    resolveCapabilities(userId: string, nodeId: string, client?: DocumentAuthorizationClient): Promise<ResolvedDocumentCapabilities>;
    resolveCapabilitiesForNodes(userId: string, nodeIds: readonly string[], client?: DocumentAuthorizationClient): Promise<Map<string, ResolvedDocumentCapabilities>>;
    resolveTrashCapabilities(userId: string, nodeId: string, client?: DocumentAuthorizationClient): Promise<ResolvedDocumentCapabilities>;
    private resolveCapabilitiesInternal;
    findUserGroupIds(userId: string, client?: DocumentAuthorizationClient): Promise<string[] | null>;
    resolveExplicitCapabilities(userId: string, nodeIds: readonly string[], groupIds: readonly string[], client?: DocumentAuthorizationClient): Promise<Map<string, ReadonlySet<DocumentCapability>>>;
    hasCapability(userId: string, nodeId: string, capability: DocumentCapability): Promise<boolean>;
    assertCapability(userId: string, nodeId: string, capability: DocumentCapability): Promise<void>;
    private emptyResolution;
}
