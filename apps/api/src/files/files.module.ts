import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { CollectionsModule } from '../collections/collections.module.js';
import { DriveModule } from '../drive/drive.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { FileValidationService } from './file-validation.service.js';
import { FileReadService } from './file-read.service.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { MultipartUploadService } from './multipart-upload.service.js';
import { PreviewController } from './preview.controller.js';
import { PreviewService } from './preview.service.js';
import { OfficeTemplateService } from './office-template.service.js';
import { FileWorkspacePreviewService } from './file-workspace-preview.service.js';
import { FileEngineModule } from '../file-engine/file-engine.module.js';
import { FileHistoryService } from './file-history.service.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    DatabaseModule,
    StorageModule,
    DriveModule,
    CollectionsModule,
    FileEngineModule,
  ],
  controllers: [FilesController, PreviewController],
  providers: [
    FilesService,
    MultipartUploadService,
    FileValidationService,
    FileReadService,
    PreviewService,
    OfficeTemplateService,
    FileWorkspacePreviewService,
    FileHistoryService,
  ],
  exports: [FileReadService, FileValidationService],
})
export class FilesModule {}
