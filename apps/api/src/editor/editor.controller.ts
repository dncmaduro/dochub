import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { FileReadService } from '../files/file-read.service.js';
import { CreateEditorSessionDto } from './dto/editor-session.dto.js';
import { EditorSessionService } from './editor-session.service.js';

@Controller()
export class EditorController {
  constructor(
    private readonly sessions: EditorSessionService,
    private readonly reads: FileReadService,
  ) {}

  @Post('nodes/:nodeId/editor-sessions')
  @UseGuards(AccessTokenGuard)
  @HttpCode(201)
  create(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('nodeId') nodeId: string,
    @Body() dto: CreateEditorSessionDto,
  ) {
    return this.sessions.create(auth.userId, nodeId, dto.mode);
  }

  @Post('editor-sessions/:sessionId/close')
  @UseGuards(AccessTokenGuard)
  close(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('sessionId') sessionId: string,
  ) {
    return this.sessions.close(auth.userId, sessionId);
  }

  @Get('editor-sessions/:sessionId/content')
  async content(
    @Param('sessionId') sessionId: string,
    @Query('token') token: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const authorized = await this.sessions.authorizeFetch(sessionId, token);
    const binary = await this.reads.openAuthorized(
      authorized.nodeId,
      request.header('range'),
      authorized.versionId,
    );
    this.reads.write(binary, response);
  }

  /** Document Server callback: authenticated by its signed payload and our
   * purpose-bound capability, never by a browser access token. */
  @Post('editor-sessions/:sessionId/callback')
  @HttpCode(200)
  callback(
    @Param('sessionId') sessionId: string,
    @Query('capability') capability: string,
    @Body() body: unknown,
  ) {
    return this.sessions.handleCallback(sessionId, capability, body);
  }
}
