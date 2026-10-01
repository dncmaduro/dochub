import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { CollectionsModule } from '../collections/collections.module.js';
import { FoldersController } from './folders.controller.js';
import { NodesController } from './nodes.controller.js';
import { NodesService } from './nodes.service.js';

@Module({
  imports: [AuthModule, AuthorizationModule, DatabaseModule, CollectionsModule],
  controllers: [FoldersController, NodesController],
  providers: [NodesService],
})
export class NodesModule {}
