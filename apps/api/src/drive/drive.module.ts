import { Module } from '@nestjs/common';
import { AuthConfigModule } from '../auth/auth-config.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AUTH_CONFIG } from '../auth/auth.config.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import {
  DRIVE_CONFIG,
  loadDriveConfig,
} from './drive.config.js';
import { DriveController } from './drive.controller.js';
import { DriveCreationTargetService } from './drive-creation-target.service.js';
import { DriveOrganizationService } from './drive-organization.service.js';
import { DriveOAuthStateService } from './drive-oauth-state.service.js';
import { DriveService } from './drive.service.js';
import { DriveTokenCryptoService } from './drive-token-crypto.service.js';
import {
  DRIVE_PROVIDER,
  GoogleDriveApiProvider,
} from './google-drive.provider.js';

@Module({
  imports: [DatabaseModule, AuthConfigModule, AuthModule, AuthorizationModule],
  controllers: [DriveController],
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
    DriveOAuthStateService,
    DriveTokenCryptoService,
    DriveCreationTargetService,
    DriveService,
    DriveOrganizationService,
  ],
  exports: [DriveService, DriveOrganizationService],
})
export class DriveModule {}
