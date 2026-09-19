import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';
import { AuthSessionService } from './auth-session.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authSessions: AuthSessionService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  @Post('refresh')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: number }> {
    const refreshToken = this.refreshTokenFrom(request);
    if (!refreshToken) {
      throw new UnauthorizedException('Authentication failed');
    }

    const tokens = await this.authSessions.refreshSession(refreshToken);
    response.cookie(
      this.config.refreshCookieName,
      tokens.refreshToken,
      this.refreshCookieOptions(),
    );
    return {
      accessToken: tokens.accessToken,
      tokenType: 'Bearer',
      expiresIn: tokens.expiresIn,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const refreshToken = this.refreshTokenFrom(request);
    if (refreshToken) {
      await this.authSessions.revokeSession(refreshToken);
    }

    response.clearCookie(
      this.config.refreshCookieName,
      this.refreshCookieOptions(false),
    );
  }

  private refreshTokenFrom(request: Request): string | undefined {
    const cookie = request.cookies?.[this.config.refreshCookieName];
    return typeof cookie === 'string' ? cookie : undefined;
  }

  private refreshCookieOptions(includeMaxAge = true): CookieOptions {
    const options: CookieOptions = {
      httpOnly: true,
      secure: this.config.refreshCookieSecure,
      sameSite: this.config.refreshCookieSameSite,
      path: '/auth',
    };

    if (this.config.refreshCookieDomain) {
      options.domain = this.config.refreshCookieDomain;
    }
    if (includeMaxAge) {
      options.maxAge = this.config.refreshTokenLifetimeMs;
    }

    return options;
  }
}
