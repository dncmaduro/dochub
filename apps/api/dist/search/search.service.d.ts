import { NodeType } from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { SearchQueryDto } from './search.dto.js';
export declare class SearchService {
    private readonly database;
    private readonly authorization;
    constructor(database: DatabaseService, authorization: DocumentAuthorizationService);
    search(actorId: string, dto: SearchQueryDto): Promise<{
        items: {
            id: string;
            type: NodeType;
            name: string;
            updatedAt: string;
        }[];
        nextCursor: string | null;
    }>;
    private candidates;
}
