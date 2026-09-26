import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';
@Module({
  imports: [AuthModule, AuthorizationModule, DatabaseModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
