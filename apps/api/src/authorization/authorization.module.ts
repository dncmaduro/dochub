import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DocumentAuthorizationService } from './document-authorization.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [DocumentAuthorizationService],
  exports: [DocumentAuthorizationService],
})
export class AuthorizationModule {}
