import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { SystemAdminGuard } from '../common/system-admin.guard.js';
import { AdminService } from './admin.service.js';
import {
  CreateUserDto,
  ListUsersQueryDto,
  UpdateUserDto,
  UserIdParamDto,
} from './dto/admin.dto.js';

@Controller('admin/users')
@UseGuards(AccessTokenGuard, SystemAdminGuard)
export class AdminUsersController {
  constructor(private readonly admin: AdminService) {}

  @Post()
  create(@CurrentAuth() auth: AuthPrincipal, @Body() dto: CreateUserDto) {
    return this.admin.createUser(auth.userId, dto);
  }

  @Get()
  list(@Query() query: ListUsersQueryDto) {
    return this.admin.listUsers(query);
  }

  @Get(':userId')
  get(@Param() params: UserIdParamDto) {
    return this.admin.getUser(params.userId);
  }

  @Patch(':userId')
  update(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: UserIdParamDto,
    @Body() dto: UpdateUserDto,
  ) {
    return this.admin.updateUser(auth.userId, params.userId, dto);
  }
}
