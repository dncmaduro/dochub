import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { DatabaseService } from '../database/database.service.js';
import { TikaClient } from '../tika/tika.client.js';
import { loadFileProcessingConfig } from './file-processing.config.js';
import { GoogleDriveRevisionContentReader } from './revision-content-reader.js';
import { RevisionFileProcessingService } from './revision-file-processing.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: RevisionFileProcessingService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => {
        const config = loadFileProcessingConfig();
        return new RevisionFileProcessingService(
          database.prisma,
          new GoogleDriveRevisionContentReader(database.prisma),
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
  exports: [RevisionFileProcessingService],
})
export class FileProcessingModule {}
