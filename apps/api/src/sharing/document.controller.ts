import {
  Controller,
  Body,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OptionalAccessTokenGuard } from '../auth/optional-access-token.guard.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { EditorSessionService } from '../editor/editor-session.service.js';
import { CreateEditorSessionDto } from '../editor/dto/editor-session.dto.js';
import { UnsatisfiableRangeError } from '../files/byte-range.js';
import { FileReadService } from '../files/file-read.service.js';
import { DocumentAccessService } from './document-access.service.js';

@Controller('documents')
@UseGuards(OptionalAccessTokenGuard)
export class DocumentController {
  constructor(
    private readonly access: DocumentAccessService,
    private readonly reads: FileReadService,
    private readonly editors: EditorSessionService,
  ) {}

  @Get(':nodeId')
  @Header('Cache-Control', 'private, no-store')
  async resolve(
    @Param('nodeId') nodeId: string,
    @CurrentAuth() auth: AuthPrincipal | undefined,
  ) {
    const resolved = await this.access.resolve(nodeId, auth, DocumentCapability.VIEW);
    return {
      node: resolved.node,
      access: {
        mode: resolved.mode,
        generalAccessRole: resolved.generalAccessRole,
        editorMode: resolved.capabilities.has(DocumentCapability.EDIT) ? 'EDIT' : 'VIEW',
        canPreview:
          resolved.node.type === 'FILE' &&
          resolved.capabilities.has(DocumentCapability.PREVIEW),
        canDownload:
          resolved.mode === 'AUTHENTICATED' &&
          resolved.capabilities.has(DocumentCapability.DOWNLOAD),
      },
    };
  }

  @Post(':nodeId/editor-sessions')
  @HttpCode(201)
  async createEditorSession(
    @Param('nodeId') nodeId: string,
    @CurrentAuth() auth: AuthPrincipal | undefined,
    @Body() body?: CreateEditorSessionDto,
  ) {
    await this.access.resolve(nodeId, auth, DocumentCapability.VIEW);
    return auth
      ? this.editors.create(auth.userId, nodeId, body?.mode)
      : this.editors.createPublic(nodeId, body?.mode);
  }

  @Post(':nodeId/editor-sessions/:sessionId/close')
  @HttpCode(202)
  async closeEditorSession(
    @Param('nodeId') nodeId: string,
    @Param('sessionId') sessionId: string,
    @CurrentAuth() auth: AuthPrincipal | undefined,
  ) {
    await this.access.resolve(nodeId, auth, DocumentCapability.VIEW);
    return auth
      ? this.editors.close(auth.userId, sessionId)
      : this.editors.closePublic(nodeId, sessionId);
  }

  @Get(':nodeId/editor-sessions/:sessionId/status')
  async editorSessionStatus(
    @Param('nodeId') nodeId: string,
    @Param('sessionId') sessionId: string,
    @CurrentAuth() auth: AuthPrincipal | undefined,
  ) {
    await this.access.resolve(nodeId, auth, DocumentCapability.VIEW);
    return auth
      ? this.editors.status(auth.userId, sessionId)
      : this.editors.statusPublic(nodeId, sessionId);
  }

  @Get(':nodeId/content')
  async content(
    @Param('nodeId') nodeId: string,
    @CurrentAuth() auth: AuthPrincipal | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.access.resolve(nodeId, auth, DocumentCapability.PREVIEW);
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      this.reads.write(
        await this.reads.openAuthorized(nodeId, request.header('range')),
        response,
      );
    } catch (error) {
      if (error instanceof UnsatisfiableRangeError) {
        response.setHeader('Content-Range', `bytes */${error.totalSize}`);
        response.status(416).end();
        return;
      }
      throw error;
    }
  }
}
