import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { FilesModule } from './files/files.module.js';
import { HealthController } from './health/health.controller.js';
import { NodesModule } from './nodes/nodes.module.js';
import { PermissionsModule } from './permissions/permissions.module.js';
import { TrashModule } from './trash/trash.module.js';
import { SharingModule } from './sharing/sharing.module.js';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AdminModule,
    AuthorizationModule,
    NodesModule,
    PermissionsModule,
    FilesModule,
    TrashModule,
    SharingModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
