import type { AuthPrincipal } from '../auth/auth.types.js';
import { TrashService } from './trash.service.js';
export declare class TrashController {
    private readonly trash;
    constructor(trash: TrashService);
    moveToTrash(auth: AuthPrincipal, nodeId: string): Promise<{
        operation: {
            id: string;
            rootNodeId: string;
            status: import("@prisma/client").$Enums.TrashOperationStatus;
            trashedAt: Date;
            expiresAt: Date;
        };
        affectedNodeCount: number;
    }>;
    restore(auth: AuthPrincipal, operationId: string): Promise<{
        operation: {
            id: string;
            rootNodeId: string | null;
            status: import("@prisma/client").$Enums.TrashOperationStatus;
            restoredAt: Date | null;
        };
        restoredNodeCount: number;
    }>;
    purge(auth: AuthPrincipal, operationId: string): Promise<any>;
}
