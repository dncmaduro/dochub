import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import {
  AccessTokenGuard,
  type AuthenticatedRequest,
} from './access-token.guard.js';

/** Allows requests without credentials, but validates supplied credentials exactly as normal auth does. */
@Injectable()
export class OptionalAccessTokenGuard implements CanActivate {
  constructor(private readonly accessTokens: AccessTokenGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.headers.authorization === undefined) return true;
    await this.accessTokens.authenticateRequest(request);
    return true;
  }
}
