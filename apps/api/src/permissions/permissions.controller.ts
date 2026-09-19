import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import {
  NodeGroupPermissionParamDto,
  NodePermissionParamDto,
  NodeUserPermissionParamDto,
  SetPermissionRoleDto,
  UpdatePermissionSettingsDto,
} from './dto/permission.dto.js';
import { PermissionsService } from './permissions.service.js';

@Controller('nodes/:nodeId/permissions')
@UseGuards(AccessTokenGuard)
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: NodePermissionParamDto,
  ) {
    return this.permissions.list(auth.userId, params.nodeId);
  }

  @Put('users/:userId')
  setUser(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: NodeUserPermissionParamDto,
    @Body() dto: SetPermissionRoleDto,
  ) {
    return this.permissions.setUser(
      auth.userId,
      params.nodeId,
      params.userId,
      dto,
    );
  }

  @Put('groups/:groupId')
  setGroup(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: NodeGroupPermissionParamDto,
    @Body() dto: SetPermissionRoleDto,
  ) {
    return this.permissions.setGroup(
      auth.userId,
      params.nodeId,
      params.groupId,
      dto,
    );
  }

  @Delete('users/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeUser(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: NodeUserPermissionParamDto,
  ): Promise<void> {
    await this.permissions.removeUser(
      auth.userId,
      params.nodeId,
      params.userId,
    );
  }

  @Delete('groups/:groupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeGroup(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: NodeGroupPermissionParamDto,
  ): Promise<void> {
    await this.permissions.removeGroup(
      auth.userId,
      params.nodeId,
      params.groupId,
    );
  }

  @Patch('settings')
  updateSettings(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: NodePermissionParamDto,
    @Body() dto: UpdatePermissionSettingsDto,
  ) {
    return this.permissions.updateSettings(auth.userId, params.nodeId, dto);
  }
}
