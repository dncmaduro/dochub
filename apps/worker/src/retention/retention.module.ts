import { Module } from '@nestjs/common';
import { LocalFileStorage } from '@dochub/storage';
import { TrashPurgeEngine } from '@dochub/trash';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { loadRetentionConfig } from './retention.config.js';
import { RetentionService } from './retention.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: RetentionService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => {
        const config = loadRetentionConfig();
        if (process.env.STORAGE_DRIVER !== 'local') {
          throw new Error('STORAGE_DRIVER must be local');
        }
        const storage = new LocalFileStorage(process.env.STORAGE_ROOT ?? '');
        return new RetentionService(
          database.prisma,
          new TrashPurgeEngine(database.prisma, storage),
          config,
        );
      },
    },
  ],
  exports: [RetentionService],
})
export class RetentionModule {}
