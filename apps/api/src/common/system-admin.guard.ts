import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SystemRole, UserStatus } from '@dochub/database';
import { DatabaseService } from '../database/database.service.js';
import type { AuthenticatedRequest } from '../auth/access-token.guard.js';

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
    if (
      user?.status !== UserStatus.ACTIVE ||
      user.systemRole !== SystemRole.ADMIN
    ) {
      throw new ForbiddenException('System administrator access is required');
    }

    return true;
  }
}
