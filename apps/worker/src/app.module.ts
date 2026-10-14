import { Module } from '@nestjs/common';
import { RetentionModule } from './retention/retention.module.js';
import { FileProcessingModule } from './file-processing/file-processing.module.js';
import { FileMutationReconciliationModule } from './file-mutation-reconciliation/file-mutation-reconciliation.module.js';

@Module({
  imports: [RetentionModule, FileProcessingModule, FileMutationReconciliationModule],
})
export class AppModule {}
