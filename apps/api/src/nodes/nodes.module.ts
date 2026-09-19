import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { FoldersController } from './folders.controller.js';
import { NodesController } from './nodes.controller.js';
import { NodesService } from './nodes.service.js';

@Module({
  imports: [AuthModule, AuthorizationModule, DatabaseModule],
  controllers: [FoldersController, NodesController],
  providers: [NodesService],
})
export class NodesModule {}
