import { Body, Controller, Get, Param, Patch, Req, Res, Post, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthCookieService } from '../auth/auth-cookie.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { applyPreviewContentSecurityHeaders } from '../common/security-headers.js';
import { DrivePreviewService } from './drive-preview.service.js';

@Controller()
export class DrivePreviewController {
  constructor(
    private readonly previews: DrivePreviewService,
    private readonly cookies: AuthCookieService,
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

  @Patch('nodes/:nodeId/document')
  @UseGuards(AccessTokenGuard)
  async saveDocument(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('nodeId') nodeId: string,
    @Body() body: unknown,
  ) {
    return this.previews.saveDocument(auth.userId, nodeId, body);
  }

  @Patch('nodes/:nodeId/spreadsheet')
  @UseGuards(AccessTokenGuard)
  async saveSpreadsheet(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('nodeId') nodeId: string,
    @Body() body: unknown,
  ) {
    return this.previews.saveSpreadsheet(auth.userId, nodeId, body);
  }

  @Patch('nodes/:nodeId/presentation')
  @UseGuards(AccessTokenGuard)
  async savePresentation(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('nodeId') nodeId: string,
    @Body() body: unknown,
  ) {
    return this.previews.savePresentation(auth.userId, nodeId, body);
  }

  @Patch('nodes/:nodeId/text')
  @UseGuards(AccessTokenGuard)
  async saveText(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('nodeId') nodeId: string,
    @Body() body: unknown,
  ) {
    return this.previews.saveText(auth.userId, nodeId, body);
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
    applyPreviewContentSecurityHeaders(response);
    response.setHeader('Referrer-Policy', 'no-referrer');
    this.previews.write(content, preview, response);
  }

  @Get('drive-preview/:sessionId/content/model')
  async model(
    @Param('sessionId') sessionId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const token = request.cookies?.[this.previews.cookieName(sessionId)];
    const preview = await this.previews.verify(sessionId, token);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.json(await this.previews.openModel(preview));
  }

  @Get('drive-preview/:sessionId/content/sheets/:sheetId')
  async sheet(
    @Param('sessionId') sessionId: string,
    @Param('sheetId') sheetId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const token = request.cookies?.[this.previews.cookieName(sessionId)];
    const preview = await this.previews.verify(sessionId, token);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.json(await this.previews.openSheet(preview, sheetId));
  }

  @Get('drive-preview/:sessionId/content/slides/:slideId')
  async slide(
    @Param('sessionId') sessionId: string,
    @Param('slideId') slideId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const token = request.cookies?.[this.previews.cookieName(sessionId)];
    const preview = await this.previews.verify(sessionId, token);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.json(await this.previews.openSlide(preview, slideId));
  }

  @Get('drive-preview/:sessionId/content/assets/:assetId')
  async asset(
    @Param('sessionId') sessionId: string,
    @Param('assetId') assetId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const token = request.cookies?.[this.previews.cookieName(sessionId)];
    const preview = await this.previews.verify(sessionId, token);
    const content = await this.previews.openAsset(preview, assetId);
    applyPreviewContentSecurityHeaders(response);
    response.setHeader('Referrer-Policy', 'no-referrer');
    this.previews.write(content, preview, response, content.mimeType);
  }
}
