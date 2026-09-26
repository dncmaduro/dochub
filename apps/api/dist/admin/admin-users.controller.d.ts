import type { AuthPrincipal } from '../auth/auth.types.js';
import { AdminService } from './admin.service.js';
import { CreateUserDto, ListUsersQueryDto, UpdateUserDto, UserIdParamDto } from './dto/admin.dto.js';
export declare class AdminUsersController {
    private readonly admin;
    constructor(admin: AdminService);
    create(auth: AuthPrincipal, dto: CreateUserDto): Promise<import("./admin.types.js").AdminUserResponse>;
    list(query: ListUsersQueryDto): Promise<import("./admin.types.js").CursorPage<import("./admin.types.js").AdminUserResponse>>;
    get(params: UserIdParamDto): Promise<import("./admin.types.js").AdminUserResponse>;
    update(auth: AuthPrincipal, params: UserIdParamDto, dto: UpdateUserDto): Promise<import("./admin.types.js").AdminUserResponse>;
}
