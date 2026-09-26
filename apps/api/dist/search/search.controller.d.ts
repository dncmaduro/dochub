import type { AuthPrincipal } from '../auth/auth.types.js';
import { SearchQueryDto } from './search.dto.js';
import { SearchService } from './search.service.js';
export declare class SearchController {
    private readonly search;
    constructor(search: SearchService);
    find(auth: AuthPrincipal, query: SearchQueryDto): Promise<{
        items: {
            id: string;
            type: import("@prisma/client").NodeType;
            name: string;
            updatedAt: string;
        }[];
        nextCursor: string | null;
    }>;
}
