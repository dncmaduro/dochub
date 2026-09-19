import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CreateFolderDto } from './dto/node.dto.js';
import { NodesService } from './nodes.service.js';

@Controller('folders')
@UseGuards(AccessTokenGuard)
export class FoldersController {
  constructor(private readonly nodes: NodesService) {}

  @Post()
  create(@CurrentAuth() auth: AuthPrincipal, @Body() dto: CreateFolderDto) {
    return this.nodes.createFolder(auth.userId, dto);
  }
}
