import { Module } from '@nestjs/common';
import { LocalFileStorage } from '@dochub/storage';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { TikaClient } from '../tika/tika.client.js';
import { loadFileProcessingConfig } from './file-processing.config.js';
import { FileProcessingService } from './file-processing.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: FileProcessingService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => {
        const config = loadFileProcessingConfig();
        if (process.env.STORAGE_DRIVER !== 'local')
          throw new Error('STORAGE_DRIVER must be local');
        const storage = new LocalFileStorage(process.env.STORAGE_ROOT ?? '');
        return new FileProcessingService(
          database.prisma,
          storage,
          new TikaClient(
            config.tikaUrl,
            config.tikaRequestTimeoutSeconds * 1000,
            config.tikaMaxTextBytes,
          ),
          config,
        );
      },
    },
  ],
})
export class FileProcessingModule {}
