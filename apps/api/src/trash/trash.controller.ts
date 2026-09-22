import { Controller, Delete, Param, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { TrashService } from './trash.service.js';
@Controller('nodes')
@UseGuards(AccessTokenGuard)
export class TrashController {
  constructor(private readonly trash: TrashService) {}
  @Delete(':nodeId')
  moveToTrash(@CurrentAuth() auth: AuthPrincipal, @Param('nodeId') nodeId: string) { return this.trash.trash(auth.userId, nodeId); }
}
