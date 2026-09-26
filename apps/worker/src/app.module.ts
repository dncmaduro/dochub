import { Module } from '@nestjs/common';
import { RetentionModule } from './retention/retention.module.js';
import { FileProcessingModule } from './file-processing/file-processing.module.js';

@Module({
  imports: [RetentionModule, FileProcessingModule],
})
export class AppModule {}
