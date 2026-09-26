import { DocumentRole } from '@dochub/database';
export declare class NodePermissionParamDto {
    nodeId: string;
}
export declare class NodeUserPermissionParamDto extends NodePermissionParamDto {
    userId: string;
}
export declare class NodeGroupPermissionParamDto extends NodePermissionParamDto {
    groupId: string;
}
export declare class SetPermissionRoleDto {
    role: DocumentRole;
}
export declare class UpdatePermissionSettingsDto {
    inheritPermissions: boolean;
}
