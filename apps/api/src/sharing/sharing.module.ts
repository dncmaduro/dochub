import { Module } from '@nestjs/common';
import { AuthConfigModule } from '../auth/auth-config.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { FilesModule } from '../files/files.module.js';
import { EditorModule } from '../editor/editor.module.js';
import { DocumentController } from './document.controller.js';
import { DocumentAccessService } from './document-access.service.js';
import { SharingController } from './sharing.controller.js';
import { SharingDirectoryController } from './sharing-directory.controller.js';
import { SharingService } from './sharing.service.js';

@Module({
  imports: [
    AuthModule,
    AuthConfigModule,
    AuthorizationModule,
    DatabaseModule,
    FilesModule,
    EditorModule,
  ],
  controllers: [SharingController, SharingDirectoryController, DocumentController],
  providers: [SharingService, DocumentAccessService],
})
export class SharingModule {}
