import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Response } from 'express';
import { DocumentCapability } from '../authorization/document-capability.js';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { FilesService } from './files.service.js';
import { FileReadService } from './file-read.service.js';
import { UnsatisfiableRangeError } from './byte-range.js';
import { MultipartUploadService } from './multipart-upload.service.js';

@Controller()
@UseGuards(AccessTokenGuard)
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly reads: FileReadService,
    private readonly multipart: MultipartUploadService,
  ) {}

  @Post('files')
  @HttpCode(201)
  async createInitial(
    @CurrentAuth() auth: AuthPrincipal,
    @Req() request: Request,
  ) {
    const upload = await this.multipart.receive(request);
    try {
      return await this.files.createInitial(auth.userId, upload);
    } finally {
      await this.multipart.cleanup(upload.tempPath);
    }
  }

  @Post('nodes/:nodeId/versions')
  @HttpCode(201)
  async createVersion(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('nodeId') nodeId: string,
    @Req() request: Request,
  ) {
    const upload = await this.multipart.receive(request);
    try {
      return await this.files.createVersion(auth.userId, nodeId, upload);
    } finally {
      await this.multipart.cleanup(upload.tempPath);
    }
  }

  @Get('nodes/:nodeId/content')
  async currentContent(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('nodeId') nodeId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.stream(
      auth.userId,
      nodeId,
      DocumentCapability.PREVIEW,
      request,
      response,
    );
  }

  @Get('nodes/:nodeId/download')
  async currentDownload(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('nodeId') nodeId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.stream(
      auth.userId,
      nodeId,
      DocumentCapability.DOWNLOAD,
      request,
      response,
      undefined,
      true,
    );
  }

  @Get('nodes/:nodeId/versions/:versionId/content')
  async historicalContent(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('nodeId') nodeId: string,
    @Param('versionId') versionId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.stream(
      auth.userId,
      nodeId,
      DocumentCapability.PREVIEW,
      request,
      response,
      versionId,
    );
  }

  @Get('nodes/:nodeId/versions/:versionId/download')
  async historicalDownload(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('nodeId') nodeId: string,
    @Param('versionId') versionId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.stream(
      auth.userId,
      nodeId,
      DocumentCapability.DOWNLOAD,
      request,
      response,
      versionId,
      true,
    );
  }

  private async stream(
    actorUserId: string,
    nodeId: string,
    capability: DocumentCapability.PREVIEW | DocumentCapability.DOWNLOAD,
    request: Request,
    response: Response,
    versionId?: string,
    attachment = false,
  ): Promise<void> {
    let binary;
    try {
      binary = await this.reads.open(
        actorUserId,
        nodeId,
        capability,
        request.header('range'),
        versionId,
      );
    } catch (error) {
      if (error instanceof UnsatisfiableRangeError) {
        response.setHeader('Content-Range', `bytes */${error.totalSize}`);
        response.status(416).end();
        return;
      }
      throw error;
    }
    this.reads.write(binary, response, attachment);
  }
}
