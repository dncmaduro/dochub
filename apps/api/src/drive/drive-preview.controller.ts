import { Controller, Get, Inject, Param, Req, Res, Post, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthCookieService } from '../auth/auth-cookie.service.js';
import { AUTH_CONFIG, type AuthConfig } from '../auth/auth.config.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { DrivePreviewService } from './drive-preview.service.js';

@Controller()
export class DrivePreviewController {
  constructor(
    private readonly previews: DrivePreviewService,
    private readonly cookies: AuthCookieService,
    @Inject(AUTH_CONFIG) private readonly authConfig: AuthConfig,
  ) {}

  @Post('nodes/:nodeId/drive-preview-session')
  @UseGuards(AccessTokenGuard)
  async create(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('nodeId') nodeId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const preview = await this.previews.create(auth.userId, nodeId);
    if (!preview) return { previewable: false };
    response.cookie(
      this.previews.cookieName(preview.sessionId),
      preview.token,
      this.cookies.drivePreviewOptions(preview.sessionId),
    );
    const { token: _token, ...body } = preview;
    return body;
  }

  @Get('drive-preview/:sessionId/content')
  async content(
    @Param('sessionId') sessionId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const token = request.cookies?.[this.previews.cookieName(sessionId)];
    const preview = await this.previews.verify(sessionId, token);
    const content = await this.previews.openContent(preview, request.header('range'));
    response.removeHeader('X-Frame-Options');
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; frame-ancestors ${this.authConfig.webOrigins.length ? this.authConfig.webOrigins.join(' ') : "'self'"}`,
    );
    response.setHeader('Referrer-Policy', 'no-referrer');
    this.previews.write(content, preview, response);
  }
}
