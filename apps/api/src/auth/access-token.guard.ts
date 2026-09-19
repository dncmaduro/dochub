import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AuthSessionService } from './auth-session.service.js';
import type { AccessTokenPayload, AuthPrincipal } from './auth.types.js';

export interface AuthenticatedRequest extends Request {
  auth?: AuthPrincipal;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authSessions: AuthSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.bearerToken(request.headers.authorization);

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw this.authenticationFailed();
    }

    if (!this.isAccessTokenPayload(payload)) {
      throw this.authenticationFailed();
    }

    request.auth = await this.authSessions.validateAccessSession({
      userId: payload.sub,
      sessionId: payload.sid,
    });
    return true;
  }

  private bearerToken(header: string | string[] | undefined): string {
    if (typeof header !== 'string') {
      throw this.authenticationFailed();
    }

    const match = /^Bearer ([^\s]+)$/.exec(header);
    if (!match) {
      throw this.authenticationFailed();
    }

    return match[1];
  }

  private isAccessTokenPayload(
    payload: unknown,
  ): payload is AccessTokenPayload {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const candidate = payload as Record<string, unknown>;
    return (
      candidate.typ === 'access' &&
      typeof candidate.sub === 'string' &&
      UUID_PATTERN.test(candidate.sub) &&
      typeof candidate.sid === 'string' &&
      UUID_PATTERN.test(candidate.sid)
    );
  }

  private authenticationFailed(): UnauthorizedException {
    return new UnauthorizedException('Authentication failed');
  }
}
