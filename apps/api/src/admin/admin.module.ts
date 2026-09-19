import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { SystemAdminGuard } from '../common/system-admin.guard.js';
import { AdminGroupsController } from './admin-groups.controller.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [AdminUsersController, AdminGroupsController],
  providers: [AdminService, SystemAdminGuard],
})
export class AdminModule {}
