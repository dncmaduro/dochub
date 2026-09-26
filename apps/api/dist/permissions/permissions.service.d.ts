import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import { SetPermissionRoleDto, UpdatePermissionSettingsDto } from './dto/permission.dto.js';
import type { NodePermissionsResponse, PermissionEntryResponse } from './permissions.types.js';
export declare class PermissionsService {
    private readonly database;
    private readonly authorization;
    constructor(database: DatabaseService, authorization: DocumentAuthorizationService);
    list(actorUserId: string, nodeId: string): Promise<NodePermissionsResponse>;
    setUser(actorUserId: string, nodeId: string, userId: string, dto: SetPermissionRoleDto): Promise<PermissionEntryResponse>;
    setGroup(actorUserId: string, nodeId: string, groupId: string, dto: SetPermissionRoleDto): Promise<PermissionEntryResponse>;
    removeUser(actorUserId: string, nodeId: string, userId: string): Promise<void>;
    removeGroup(actorUserId: string, nodeId: string, groupId: string): Promise<void>;
    updateSettings(actorUserId: string, nodeId: string, dto: UpdatePermissionSettingsDto): Promise<{
        nodeId: string;
        inheritPermissions: boolean;
    }>;
    private requireManagePermission;
    private assertPermissionMutationSafe;
    private requireUserPermissionResponse;
    private requireGroupPermissionResponse;
    private permissionResponse;
    private compareEntries;
    private writeAudit;
    private withSerializableRetry;
    private isSerializationConflict;
}
