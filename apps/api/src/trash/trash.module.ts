import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { TRASH_CONFIG, loadTrashConfig } from './trash.config.js';
import { TrashController } from './trash.controller.js';
import { TrashService } from './trash.service.js';
@Module({ imports: [AuthModule, AuthorizationModule, DatabaseModule], controllers: [TrashController], providers: [TrashService, { provide: TRASH_CONFIG, useFactory: loadTrashConfig }] })
export class TrashModule {}
