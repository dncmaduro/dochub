import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { OptionalAccessTokenGuard } from '../auth/optional-access-token.guard.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { UnsatisfiableRangeError } from '../files/byte-range.js';
import { FileReadService } from '../files/file-read.service.js';
import { ShareResolutionService } from './share-resolution.service.js';

@Controller('share')
@UseGuards(OptionalAccessTokenGuard)
export class ShareController {
  constructor(
    private readonly resolution: ShareResolutionService,
    private readonly reads: FileReadService,
  ) {}

  @Get(':token')
  async resolve(
    @Param('token') token: string,
    @CurrentAuth() auth: AuthPrincipal | undefined,
  ) {
    const resolved = await this.resolution.resolve(
      token,
      auth,
      DocumentCapability.VIEW,
    );
    return {
      node: {
        id: resolved.node.id,
        type: resolved.node.type,
        name: resolved.node.name,
      },
      access: {
        mode: resolved.mode,
        canPreview:
          resolved.node.type === 'FILE' &&
          resolved.capabilities.has(DocumentCapability.PREVIEW),
        canDownload:
          resolved.mode === 'AUTHENTICATED' &&
          resolved.capabilities.has(DocumentCapability.DOWNLOAD),
      },
    };
  }

  @Get(':token/content')
  async content(
    @Param('token') token: string,
    @CurrentAuth() auth: AuthPrincipal | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const resolved = await this.resolution.resolve(
      token,
      auth,
      DocumentCapability.PREVIEW,
    );
    await this.stream(resolved.node.id, request, response, false);
  }

  @Get(':token/download')
  async download(
    @Param('token') token: string,
    @CurrentAuth() auth: AuthPrincipal | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const resolved = await this.resolution.resolve(
      token,
      auth,
      DocumentCapability.DOWNLOAD,
    );
    await this.stream(resolved.node.id, request, response, true);
  }

  private async stream(
    nodeId: string,
    request: Request,
    response: Response,
    attachment: boolean,
  ): Promise<void> {
    try {
      const binary = await this.reads.openAuthorized(
        nodeId,
        request.header('range'),
      );
      this.reads.write(binary, response, attachment);
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
