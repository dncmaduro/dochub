import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthCookieService } from './auth-cookie.service.js';
import { AuthSessionService } from './auth-session.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authSessions: AuthSessionService,
    private readonly authCookies: AuthCookieService,
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
      this.authCookies.refreshCookieName(),
      tokens.refreshToken,
      this.authCookies.refreshOptions(),
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
      this.authCookies.refreshCookieName(),
      this.authCookies.refreshOptions(false),
    );
  }

  private refreshTokenFrom(request: Request): string | undefined {
    const cookie = request.cookies?.[this.authCookies.refreshCookieName()];
    return typeof cookie === 'string' ? cookie : undefined;
  }
}
