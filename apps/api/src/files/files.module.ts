import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { FileValidationService } from './file-validation.service.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';
import { MultipartUploadService } from './multipart-upload.service.js';

@Module({
  imports: [AuthModule, AuthorizationModule, DatabaseModule, StorageModule],
  controllers: [FilesController],
  providers: [FilesService, MultipartUploadService, FileValidationService],
})
export class FilesModule {}
