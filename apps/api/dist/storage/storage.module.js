var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { LocalFileStorage } from '@dochub/storage';
import { STORAGE_CONFIG, loadStorageConfig } from './storage.config.js';
export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');
let StorageModule = class StorageModule {
};
StorageModule = __decorate([
    Module({
        providers: [
            {
                provide: STORAGE_CONFIG,
                useFactory: loadStorageConfig,
            },
            {
                provide: STORAGE_SERVICE,
                inject: [STORAGE_CONFIG],
                useFactory: (config) => new LocalFileStorage(config.root),
            },
        ],
        exports: [STORAGE_CONFIG, STORAGE_SERVICE],
    })
], StorageModule);
export { StorageModule };
//# sourceMappingURL=storage.module.js.map