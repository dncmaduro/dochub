import { SystemRole, UserStatus } from '@dochub/database';
export declare class UserIdParamDto {
    userId: string;
}
export declare class GroupIdParamDto {
    groupId: string;
}
export declare class GroupMemberParamDto extends GroupIdParamDto {
    userId: string;
}
export declare class CursorPaginationDto {
    limit?: number;
    cursor?: string;
}
export declare class ListUsersQueryDto extends CursorPaginationDto {
    status?: UserStatus;
    systemRole?: SystemRole;
    q?: string;
}
export declare class CreateUserDto {
    email: string;
    displayName: string;
    systemRole?: SystemRole;
}
export declare class UpdateUserDto {
    displayName?: string;
    systemRole?: SystemRole;
    status?: 'ACTIVE' | 'SUSPENDED';
}
export declare class CreateGroupDto {
    name: string;
    description?: string;
}
export declare class UpdateGroupDto {
    name?: string;
    description?: string;
}
export declare class AddGroupMemberDto {
    userId: string;
}
