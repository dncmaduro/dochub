import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DocumentAuthorizationService } from './document-authorization.service.js';
import { FolderAccessService } from './folder-access.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [DocumentAuthorizationService, FolderAccessService],
  exports: [DocumentAuthorizationService, FolderAccessService],
})
export class AuthorizationModule {}
