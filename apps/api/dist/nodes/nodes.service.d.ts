import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import { CreateFolderDto, MoveNodeDto, NodeListQueryDto, RenameNodeDto } from './dto/node.dto.js';
import type { BreadcrumbResponse, NodePage, NodeResponse } from './node.types.js';
export declare class NodesService {
    private readonly database;
    private readonly authorization;
    constructor(database: DatabaseService, authorization: DocumentAuthorizationService);
    createFolder(actorUserId: string, dto: CreateFolderDto): Promise<NodeResponse>;
    getNode(actorUserId: string, nodeId: string): Promise<NodeResponse>;
    listRoot(actorUserId: string, query: NodeListQueryDto): Promise<NodePage>;
    listChildren(actorUserId: string, parentId: string, query: NodeListQueryDto): Promise<NodePage>;
    breadcrumb(actorUserId: string, nodeId: string): Promise<BreadcrumbResponse>;
    renameNode(actorUserId: string, nodeId: string, dto: RenameNodeDto): Promise<NodeResponse>;
    moveNode(actorUserId: string, nodeId: string, dto: MoveNodeDto): Promise<NodeResponse>;
    private requireVisibleNode;
    private requireRootAdministrator;
    private requireFolder;
    private requireCapability;
    private assertNotDescendant;
    private principalConditions;
    private afterCursor;
    private nodePage;
    private nodeResponse;
    private writeAudit;
    private throwNameConflict;
    private isUniqueViolation;
    private isSerializationConflict;
}
