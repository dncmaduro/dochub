import type { AuthPrincipal } from '../auth/auth.types.js';
import { NodeGroupPermissionParamDto, NodePermissionParamDto, NodeUserPermissionParamDto, SetPermissionRoleDto, UpdatePermissionSettingsDto } from './dto/permission.dto.js';
import { PermissionsService } from './permissions.service.js';
export declare class PermissionsController {
    private readonly permissions;
    constructor(permissions: PermissionsService);
    list(auth: AuthPrincipal, params: NodePermissionParamDto): Promise<import("./permissions.types.js").NodePermissionsResponse>;
    setUser(auth: AuthPrincipal, params: NodeUserPermissionParamDto, dto: SetPermissionRoleDto): Promise<import("./permissions.types.js").PermissionEntryResponse>;
    setGroup(auth: AuthPrincipal, params: NodeGroupPermissionParamDto, dto: SetPermissionRoleDto): Promise<import("./permissions.types.js").PermissionEntryResponse>;
    removeUser(auth: AuthPrincipal, params: NodeUserPermissionParamDto): Promise<void>;
    removeGroup(auth: AuthPrincipal, params: NodeGroupPermissionParamDto): Promise<void>;
    updateSettings(auth: AuthPrincipal, params: NodePermissionParamDto, dto: UpdatePermissionSettingsDto): Promise<{
        nodeId: string;
        inheritPermissions: boolean;
    }>;
}
