import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import {
  SharingNodeParamDto,
  UpdateSharingDto,
} from './dto/update-sharing.dto.js';
import { SharingService } from './sharing.service.js';

@Controller('nodes/:nodeId')
@UseGuards(AccessTokenGuard)
export class SharingController {
  constructor(private readonly sharing: SharingService) {}

  @Get('sharing')
  @Header('Cache-Control', 'private, no-store')
  getState(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: SharingNodeParamDto,
  ) {
    return this.sharing.getState(auth.userId, params.nodeId);
  }

  @Post('share-link')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  ensureLink(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: SharingNodeParamDto,
  ) {
    return this.sharing.ensureLink(auth.userId, params.nodeId);
  }

  @Post('share-link/reset')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  resetLink(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: SharingNodeParamDto,
  ) {
    return this.sharing.resetLink(auth.userId, params.nodeId);
  }

  @Delete('share-link')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeLink(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: SharingNodeParamDto,
  ): Promise<void> {
    await this.sharing.revokeLink(auth.userId, params.nodeId);
  }

  @Patch('sharing')
  updatePublicAccess(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: SharingNodeParamDto,
    @Body() dto: UpdateSharingDto,
  ) {
    return this.sharing.updatePublicAccess(auth.userId, params.nodeId, dto);
  }
}
