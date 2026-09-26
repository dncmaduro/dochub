import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { FilesModule } from '../files/files.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { EDITOR_CONFIG, loadEditorConfig } from './editor.config.js';
import { EditorController } from './editor.controller.js';
import { EditorSessionService } from './editor-session.service.js';

@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    DatabaseModule,
    FilesModule,
    StorageModule,
  ],
  controllers: [EditorController],
  providers: [
    EditorSessionService,
    { provide: EDITOR_CONFIG, useFactory: loadEditorConfig },
  ],
})
export class EditorModule {}
