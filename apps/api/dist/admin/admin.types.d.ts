import type { SystemRole, UserStatus } from '@dochub/database';
export interface AdminUserResponse {
    id: string;
    email: string;
    displayName: string;
    status: UserStatus;
    systemRole: SystemRole;
    createdAt: Date;
    updatedAt: Date;
    googleConnected?: boolean;
}
export interface AdminGroupResponse {
    id: string;
    name: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    memberCount?: number;
}
export interface AdminGroupMemberResponse {
    user: AdminUserResponse;
    addedAt: Date;
}
export interface CursorPage<T> {
    items: T[];
    nextCursor: string | null;
}
