import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { PrincipalSearchDto } from './dto/principal-search.dto.js';
import { SharingService } from './sharing.service.js';

@Controller('sharing')
@UseGuards(AccessTokenGuard)
export class SharingDirectoryController {
  constructor(private readonly sharing: SharingService) {}

  @Get('principals')
  principals(
    @CurrentAuth() auth: AuthPrincipal,
    @Query() query: PrincipalSearchDto,
  ) {
    return this.sharing.findPrincipals(auth.userId, query.q);
  }
}
