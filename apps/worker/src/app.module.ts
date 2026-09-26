import { Module } from '@nestjs/common';
import { RetentionModule } from './retention/retention.module.js';

@Module({
  imports: [RetentionModule],
})
export class AppModule {}
