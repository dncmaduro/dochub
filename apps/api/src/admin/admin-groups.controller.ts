import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
  AddGroupMemberDto,
  CreateGroupDto,
  CursorPaginationDto,
  GroupIdParamDto,
  GroupMemberParamDto,
  UpdateGroupDto,
} from './dto/admin.dto.js';

@Controller('admin/groups')
@UseGuards(AccessTokenGuard, SystemAdminGuard)
export class AdminGroupsController {
  constructor(private readonly admin: AdminService) {}

  @Post()
  create(@CurrentAuth() auth: AuthPrincipal, @Body() dto: CreateGroupDto) {
    return this.admin.createGroup(auth.userId, dto);
  }

  @Get()
  list(@Query() query: CursorPaginationDto) {
    return this.admin.listGroups(query);
  }

  @Get(':groupId')
  get(@Param() params: GroupIdParamDto) {
    return this.admin.getGroup(params.groupId);
  }

  @Patch(':groupId')
  update(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: GroupIdParamDto,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.admin.updateGroup(auth.userId, params.groupId, dto);
  }

  @Get(':groupId/members')
  listMembers(
    @Param() params: GroupIdParamDto,
    @Query() query: CursorPaginationDto,
  ) {
    return this.admin.listMembers(params.groupId, query);
  }

  @Post(':groupId/members')
  @HttpCode(HttpStatus.NO_CONTENT)
  async addMember(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: GroupIdParamDto,
    @Body() dto: AddGroupMemberDto,
  ): Promise<void> {
    await this.admin.addMember(auth.userId, params.groupId, dto);
  }

  @Delete(':groupId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: GroupMemberParamDto,
  ): Promise<void> {
    await this.admin.removeMember(auth.userId, params.groupId, params.userId);
  }
}
