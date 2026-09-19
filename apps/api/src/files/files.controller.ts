import {
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { FilesService } from './files.service.js';
import { MultipartUploadService } from './multipart-upload.service.js';

@Controller()
@UseGuards(AccessTokenGuard)
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly multipart: MultipartUploadService,
  ) {}

  @Post('files')
  @HttpCode(201)
  async createInitial(@CurrentAuth() auth: AuthPrincipal, @Req() request: Request) {
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
}
