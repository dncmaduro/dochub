import { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { type PrismaClient } from '@dochub/database';
export declare class DatabaseService implements OnModuleInit, OnApplicationShutdown {
    private readonly logger;
    readonly prisma: PrismaClient;
    onModuleInit(): Promise<void>;
    onApplicationShutdown(): Promise<void>;
    ping(): Promise<void>;
    private assertDatabaseUrl;
}
