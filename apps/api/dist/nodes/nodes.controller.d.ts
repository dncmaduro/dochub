import type { AuthPrincipal } from '../auth/auth.types.js';
import { MoveNodeDto, NodeIdParamDto, NodeListQueryDto, RenameNodeDto } from './dto/node.dto.js';
import { NodesService } from './nodes.service.js';
export declare class NodesController {
    private readonly nodes;
    constructor(nodes: NodesService);
    listRoot(auth: AuthPrincipal, query: NodeListQueryDto): Promise<import("./node.types.js").NodePage>;
    listChildren(auth: AuthPrincipal, params: NodeIdParamDto, query: NodeListQueryDto): Promise<import("./node.types.js").NodePage>;
    breadcrumb(auth: AuthPrincipal, params: NodeIdParamDto): Promise<import("./node.types.js").BreadcrumbResponse>;
    get(auth: AuthPrincipal, params: NodeIdParamDto): Promise<import("./node.types.js").NodeResponse>;
    rename(auth: AuthPrincipal, params: NodeIdParamDto, dto: RenameNodeDto): Promise<import("./node.types.js").NodeResponse>;
    move(auth: AuthPrincipal, params: NodeIdParamDto, dto: MoveNodeDto): Promise<import("./node.types.js").NodeResponse>;
}
