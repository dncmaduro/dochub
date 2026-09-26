import type { AuthPrincipal } from '../auth/auth.types.js';
import { CreateFolderDto } from './dto/node.dto.js';
import { NodesService } from './nodes.service.js';
export declare class FoldersController {
    private readonly nodes;
    constructor(nodes: NodesService);
    create(auth: AuthPrincipal, dto: CreateFolderDto): Promise<import("./node.types.js").NodeResponse>;
}
