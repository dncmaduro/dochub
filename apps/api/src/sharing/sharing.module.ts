import { Module } from '@nestjs/common';
import { AuthConfigModule } from '../auth/auth-config.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { SharingController } from './sharing.controller.js';
import { SharingService } from './sharing.service.js';

@Module({
  imports: [AuthModule, AuthConfigModule, AuthorizationModule, DatabaseModule],
  controllers: [SharingController],
  providers: [SharingService],
})
export class SharingModule {}
