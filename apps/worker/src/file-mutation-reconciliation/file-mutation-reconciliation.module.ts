import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { loadFileMutationReconciliationConfig } from './file-mutation-reconciliation.config.js';
import { FileMutationReconciliationService } from './file-mutation-reconciliation.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [{
    provide: FileMutationReconciliationService,
    inject: [DatabaseService],
    useFactory: (database: DatabaseService) => new FileMutationReconciliationService(database.prisma, loadFileMutationReconciliationConfig()),
  }],
})
export class FileMutationReconciliationModule {}
