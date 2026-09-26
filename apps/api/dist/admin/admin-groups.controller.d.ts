import type { AuthPrincipal } from '../auth/auth.types.js';
import { AdminService } from './admin.service.js';
import { AddGroupMemberDto, CreateGroupDto, CursorPaginationDto, GroupIdParamDto, GroupMemberParamDto, UpdateGroupDto } from './dto/admin.dto.js';
export declare class AdminGroupsController {
    private readonly admin;
    constructor(admin: AdminService);
    create(auth: AuthPrincipal, dto: CreateGroupDto): Promise<import("./admin.types.js").AdminGroupResponse>;
    list(query: CursorPaginationDto): Promise<import("./admin.types.js").CursorPage<import("./admin.types.js").AdminGroupResponse>>;
    get(params: GroupIdParamDto): Promise<import("./admin.types.js").AdminGroupResponse>;
    update(auth: AuthPrincipal, params: GroupIdParamDto, dto: UpdateGroupDto): Promise<import("./admin.types.js").AdminGroupResponse>;
    listMembers(params: GroupIdParamDto, query: CursorPaginationDto): Promise<import("./admin.types.js").CursorPage<import("./admin.types.js").AdminGroupMemberResponse>>;
    addMember(auth: AuthPrincipal, params: GroupIdParamDto, dto: AddGroupMemberDto): Promise<void>;
    removeMember(auth: AuthPrincipal, params: GroupMemberParamDto): Promise<void>;
}
