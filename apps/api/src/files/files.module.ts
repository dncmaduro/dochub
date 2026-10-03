import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { CollectionsModule } from '../collections/collections.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { FileValidationService } from './file-validation.service.js';
import { FileReadService } from './file-read.service.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { MultipartUploadService } from './multipart-upload.service.js';
import { PreviewController } from './preview.controller.js';
import { PreviewService } from './preview.service.js';

@Module({
  imports: [AuthModule, AuthorizationModule, DatabaseModule, StorageModule, CollectionsModule],
  controllers: [FilesController, PreviewController],
  providers: [
    FilesService,
    MultipartUploadService,
    FileValidationService,
    FileReadService,
    PreviewService,
  ],
  exports: [FileReadService],
})
export class FilesModule {}
