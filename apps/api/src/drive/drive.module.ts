import { Module } from '@nestjs/common';
import { AuthConfigModule } from '../auth/auth-config.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AUTH_CONFIG } from '../auth/auth.config.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { FileValidationService } from '../files/file-validation.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { FileEngineModule } from '../file-engine/file-engine.module.js';
import { STORAGE_PROVIDER } from '../storage/storage-provider.js';
import { GoogleDriveStorageProvider } from '../storage/google-drive-storage.provider.js';
import { DRIVE_CONFIG, loadDriveConfig } from './drive.config.js';
import { DriveController } from './drive.controller.js';
import { DrivePreviewController } from './drive-preview.controller.js';
import { DriveCreationTargetService } from './drive-creation-target.service.js';
import { DriveOrganizationService } from './drive-organization.service.js';
import { DriveOAuthStateService } from './drive-oauth-state.service.js';
import { DriveService } from './drive.service.js';
import { DriveFileMigrationService } from './drive-file-migration.service.js';
import { DriveUploadService } from './drive-upload.service.js';
import { DriveTokenCryptoService } from './drive-token-crypto.service.js';
import { DrivePreviewService } from './drive-preview.service.js';
import { FileSaveCoordinator } from '../file-save/file-save-coordinator.js';
import {
  DRIVE_PROVIDER,
  GoogleDriveApiProvider,
} from './google-drive.provider.js';

@Module({
  imports: [
    DatabaseModule,
    AuthConfigModule,
    AuthModule,
    AuthorizationModule,
    StorageModule,
    FileEngineModule,
  ],
  controllers: [DriveController, DrivePreviewController],
  providers: [
    {
      provide: DRIVE_CONFIG,
      inject: [AUTH_CONFIG],
      useFactory: loadDriveConfig,
    },
    {
      provide: DRIVE_PROVIDER,
      useClass: GoogleDriveApiProvider,
    },
    GoogleDriveStorageProvider,
    {
      provide: STORAGE_PROVIDER,
      useExisting: GoogleDriveStorageProvider,
    },
    FileValidationService,
    DriveOAuthStateService,
    DriveTokenCryptoService,
    DriveCreationTargetService,
    DriveService,
    DriveFileMigrationService,
    DriveUploadService,
    DriveOrganizationService,
    DrivePreviewService,
    FileSaveCoordinator,
  ],
  exports: [
    DriveService,
    DriveOrganizationService,
    DriveFileMigrationService,
    DrivePreviewService,
    STORAGE_PROVIDER,
    FileEngineModule,
    FileSaveCoordinator,
  ],
})
export class DriveModule {}
