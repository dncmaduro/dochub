import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
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

  @Patch('sharing')
  updateGeneralAccess(
    @CurrentAuth() auth: AuthPrincipal,
    @Param() params: SharingNodeParamDto,
    @Body() dto: UpdateSharingDto,
  ) {
    return this.sharing.updateGeneralAccess(auth.userId, params.nodeId, dto);
  }
}
