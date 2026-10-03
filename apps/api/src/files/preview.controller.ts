import { Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthCookieService } from '../auth/auth-cookie.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { UnsatisfiableRangeError } from './byte-range.js';
import { FileReadService } from './file-read.service.js';
import { PreviewService } from './preview.service.js';

@Controller()
export class PreviewController {
  constructor(private readonly previews: PreviewService, private readonly cookies: AuthCookieService, private readonly reads: FileReadService) {}
  @Post('nodes/:nodeId/preview-session') @UseGuards(AccessTokenGuard)
  async create(@CurrentAuth() auth: AuthPrincipal, @Param('nodeId') nodeId: string, @Res({ passthrough: true }) response: Response) {
    const preview = await this.previews.create(auth.userId, nodeId);
    if (!preview) return { previewable: false };
    response.cookie(this.previews.cookieName(preview.sessionId), preview.token, this.cookies.previewOptions(preview.sessionId));
    const { token: _token, ...body } = preview;
    return body;
  }
  @Get('preview/:sessionId/content')
  async content(@Param('sessionId') sessionId: string, @Req() request: Request, @Res() response: Response) {
    const preview = await this.previews.verify(sessionId, request.cookies?.[this.previews.cookieName(sessionId)]);
    response.setHeader('Referrer-Policy', 'no-referrer');
    try { this.reads.write(await this.reads.openAuthorized(preview.nid, request.header('range'), preview.vid), response); }
    catch (error) { if (error instanceof UnsatisfiableRangeError) { response.setHeader('Content-Range', `bytes */${error.totalSize}`); response.status(416).end(); return; } throw error; }
  }
}
