var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var DatabaseService_1;
import { Injectable, Logger } from '@nestjs/common';
import { prisma } from '@dochub/database';
let DatabaseService = DatabaseService_1 = class DatabaseService {
    logger = new Logger(DatabaseService_1.name);
    prisma = prisma;
    async onModuleInit() {
        this.assertDatabaseUrl();
        await this.prisma.$connect();
        this.logger.log('Worker database connected');
    }
    async onApplicationShutdown() {
        await this.prisma.$disconnect();
        this.logger.log('Worker database disconnected');
    }
    assertDatabaseUrl() {
        if (!process.env.DATABASE_URL) {
            throw new Error('DATABASE_URL is required');
        }
    }
};
DatabaseService = DatabaseService_1 = __decorate([
    Injectable()
], DatabaseService);
export { DatabaseService };
//# sourceMappingURL=database.service.js.map