import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UserStatus } from '@dochub/database';
import { DatabaseService } from '../database/database.service.js';
import type { AuthenticatedRequest } from '../auth/access-token.guard.js';
import { canAdministerAccounts } from './system-role-policy.js';

@Injectable()
export class SystemAdminGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) {
      throw new UnauthorizedException('Authentication failed');
    }

    const user = await this.database.prisma.user.findUnique({
      where: { id: request.auth.userId },
      select: { status: true, systemRole: true },
    });
    if (!user || user.status !== UserStatus.ACTIVE || !canAdministerAccounts(user.systemRole)) {
      throw new ForbiddenException('System administrator access is required');
    }

    return true;
  }
}
