import { Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CollectionsService } from './collections.service.js';

@Controller()
@UseGuards(AccessTokenGuard)
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Get('recent')
  recent(@CurrentAuth() auth: AuthPrincipal) {
    return this.collections.listRecent(auth.userId);
  }

  @Get('favorites')
  favorites(@CurrentAuth() auth: AuthPrincipal) {
    return this.collections.listFavorites(auth.userId);
  }

  @Post('nodes/:nodeId/favorite')
  addFavorite(@CurrentAuth() auth: AuthPrincipal, @Param('nodeId') nodeId: string) {
    return this.collections.addFavorite(auth.userId, nodeId);
  }

  @Delete('nodes/:nodeId/favorite')
  removeFavorite(@CurrentAuth() auth: AuthPrincipal, @Param('nodeId') nodeId: string) {
    return this.collections.removeFavorite(auth.userId, nodeId);
  }
}
