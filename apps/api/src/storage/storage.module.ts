import { Module } from '@nestjs/common';
import { LocalFileStorage, type StorageService } from '@dochub/storage';
import { STORAGE_CONFIG, loadStorageConfig, type StorageConfig } from './storage.config.js';

export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');

@Module({
  providers: [
    {
      provide: STORAGE_CONFIG,
      useFactory: loadStorageConfig,
    },
    {
      provide: STORAGE_SERVICE,
      inject: [STORAGE_CONFIG],
      useFactory: (config: StorageConfig): StorageService =>
        new LocalFileStorage(config.root),
    },
  ],
  exports: [STORAGE_CONFIG, STORAGE_SERVICE],
})
export class StorageModule {}
