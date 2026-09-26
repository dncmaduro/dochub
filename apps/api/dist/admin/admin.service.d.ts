import { DatabaseService } from '../database/database.service.js';
import { AddGroupMemberDto, CreateGroupDto, CreateUserDto, CursorPaginationDto, ListUsersQueryDto, UpdateGroupDto, UpdateUserDto } from './dto/admin.dto.js';
import type { AdminGroupMemberResponse, AdminGroupResponse, AdminUserResponse, CursorPage } from './admin.types.js';
export declare class AdminService {
    private readonly database;
    constructor(database: DatabaseService);
    createUser(actorUserId: string, dto: CreateUserDto): Promise<AdminUserResponse>;
    listUsers(query: ListUsersQueryDto): Promise<CursorPage<AdminUserResponse>>;
    getUser(userId: string): Promise<AdminUserResponse>;
    updateUser(actorUserId: string, userId: string, dto: UpdateUserDto): Promise<AdminUserResponse>;
    createGroup(actorUserId: string, dto: CreateGroupDto): Promise<AdminGroupResponse>;
    listGroups(query: CursorPaginationDto): Promise<CursorPage<AdminGroupResponse>>;
    getGroup(groupId: string): Promise<AdminGroupResponse>;
    updateGroup(actorUserId: string, groupId: string, dto: UpdateGroupDto): Promise<AdminGroupResponse>;
    listMembers(groupId: string, query: CursorPaginationDto): Promise<CursorPage<AdminGroupMemberResponse>>;
    addMember(actorUserId: string, groupId: string, dto: AddGroupMemberDto): Promise<void>;
    removeMember(actorUserId: string, groupId: string, userId: string): Promise<void>;
    private groupSelect;
    private userResponse;
    private groupResponse;
    private createdAtPage;
    private writeAudit;
    private throwConflictForUnique;
}
