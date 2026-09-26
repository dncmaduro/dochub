import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { SearchQueryDto } from './search.dto.js';
import { SearchService } from './search.service.js';
@Controller('search')
@UseGuards(AccessTokenGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}
  @Get() find(
    @CurrentAuth() auth: AuthPrincipal,
    @Query() query: SearchQueryDto,
  ) {
    return this.search.search(auth.userId, query);
  }
}
