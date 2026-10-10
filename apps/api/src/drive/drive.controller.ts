import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthCookieService } from '../auth/auth-cookie.service.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { SystemAdminGuard } from '../common/system-admin.guard.js';
import { DRIVE_CONFIG, type DriveConfig } from './drive.config.js';
import { DriveFilesQueryDto } from './dto/drive-files.dto.js';
import { AddToDocsHubDto } from './dto/add-to-docshub.dto.js';
import { DriveAuthorizeDto } from './dto/drive-authorize.dto.js';
import { CreateNativeDocumentDto } from './dto/create-native-document.dto.js';
import { ConfigureStorageFolderDto } from './dto/configure-storage-folder.dto.js';
import { DriveFoldersQueryDto } from './dto/drive-folders.dto.js';
import { DriveOrganizationService } from './drive-organization.service.js';
import { DriveService } from './drive.service.js';
import { DriveUploadService } from './drive-upload.service.js';

@Controller('drive')
export class DriveController {
  constructor(
    private readonly drive: DriveService,
    private readonly organization: DriveOrganizationService,
    private readonly uploads: DriveUploadService,
    private readonly authCookies: AuthCookieService,
    @Inject(DRIVE_CONFIG) private readonly config: DriveConfig,
  ) {}

  @Get('integration')
  @UseGuards(AccessTokenGuard)
  integration(@CurrentAuth() auth: AuthPrincipal) {
    return this.drive.getIntegration(auth.userId);
  }

  @Post('integration/authorize')
  @UseGuards(AccessTokenGuard, SystemAdminGuard)
  async authorize(
    @CurrentAuth() auth: AuthPrincipal,
    @Res({ passthrough: true }) response: Response,
    @Body() dto?: DriveAuthorizeDto,
  ) {
    const flow = await this.drive.beginAuthorization(
      auth.userId,
      dto?.mode ?? 'WRITE',
    );
    response.cookie(
      'dochub_drive_state',
      flow.cookieValue,
      this.authCookies.driveFlowOptions(),
    );
    return { authorizationUrl: flow.authorizationUrl };
  }

  @Post('documents')
  @UseGuards(AccessTokenGuard)
  createNativeDocument(
    @CurrentAuth() auth: AuthPrincipal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateNativeDocumentDto,
  ) {
    return this.drive.createNativeDocument(auth.userId, dto, idempotencyKey);
  }

  @Post('uploads')
  @HttpCode(201)
  @UseGuards(AccessTokenGuard)
  uploadBinary(
    @CurrentAuth() auth: AuthPrincipal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
  ) {
    return this.uploads.receive(auth.userId, request, idempotencyKey);
  }

  @Get('integration/callback')
  async callback(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const flowCookie = request.cookies?.dochub_drive_state;
    const state = this.singleQueryValue(request.query.state);
    const code = this.singleQueryValue(request.query.code);
    this.clearFlowCookie(response);
    const redirect = this.successRedirect('error');
    if (typeof flowCookie !== 'string' || !state || !code) {
      response.redirect(redirect);
      return;
    }

    try {
      await this.drive.completeAuthorization({
        cookieValue: flowCookie,
        state,
        code,
      });
      response.redirect(this.successRedirect('connected'));
    } catch {
      response.redirect(redirect);
    }
  }

  @Post('integration/sync')
  @UseGuards(AccessTokenGuard, SystemAdminGuard)
  sync(@CurrentAuth() auth: AuthPrincipal) {
    return this.drive.sync(auth.userId);
  }

  @Post('integration/disconnect')
  @UseGuards(AccessTokenGuard, SystemAdminGuard)
  disconnect(@CurrentAuth() auth: AuthPrincipal) {
    return this.drive.disconnect(auth.userId);
  }

  @Get('integration/folders')
  @UseGuards(AccessTokenGuard, SystemAdminGuard)
  folders(
    @CurrentAuth() auth: AuthPrincipal,
    @Query() query: DriveFoldersQueryDto,
  ) {
    return this.drive.listDriveFolders(auth.userId, query.q);
  }

  @Post('integration/storage-folder')
  @UseGuards(AccessTokenGuard, SystemAdminGuard)
  configureStorageFolder(
    @CurrentAuth() auth: AuthPrincipal,
    @Body() dto: ConfigureStorageFolderDto,
  ) {
    return this.drive.configureStorageFolder(auth.userId, dto.storageFolderId);
  }

  @Get('files')
  @UseGuards(AccessTokenGuard)
  files(
    @CurrentAuth() auth: AuthPrincipal,
    @Query() query: DriveFilesQueryDto,
  ) {
    return this.drive.listFiles(auth.userId, query);
  }

  @Post('files/:driveFileId/add-to-docshub')
  @UseGuards(AccessTokenGuard)
  addToDocsHub(
    @CurrentAuth() auth: AuthPrincipal,
    @Param('driveFileId') driveFileId: string,
    @Body() dto: AddToDocsHubDto,
  ) {
    return this.organization.addToDocsHub(auth.userId, driveFileId, dto);
  }

  private singleQueryValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private clearFlowCookie(response: Response): void {
    response.clearCookie(
      'dochub_drive_state',
      this.authCookies.driveFlowOptions(),
    );
  }

  private successRedirect(status: 'connected' | 'error'): string {
    const target = this.config.successRedirectUrl ?? '/admin?tab=drive';
    const url = new URL(target, 'http://localhost');
    url.searchParams.set('drive', status);
    return url.origin === 'http://localhost'
      ? `${url.pathname}${url.search}`
      : url.toString();
  }
}
