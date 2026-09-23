import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { TrashService } from './trash.service.js';
@Controller()
@UseGuards(AccessTokenGuard)
export class TrashController {
  constructor(private readonly trash: TrashService) {}

  @Delete('nodes/:nodeId')
  moveToTrash(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('nodeId') nodeId: string,
  ) {
    return this.trash.trash(auth.userId, nodeId);
  }

  @Post('trash/:operationId/restore')
  @HttpCode(HttpStatus.OK)
  restore(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('operationId') operationId: string,
  ) {
    return this.trash.restore(auth.userId, operationId);
  }

  @Delete('trash/:operationId')
  @HttpCode(HttpStatus.OK)
  purge(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('operationId') operationId: string,
  ) {
    return this.trash.purge(auth.userId, operationId);
  }
}
