import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { prisma, type PrismaClient } from '@dochub/database';

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  readonly prisma: PrismaClient = prisma;

  async onModuleInit(): Promise<void> {
    this.assertDatabaseUrl();
    await this.prisma.$connect();
    this.logger.log('API database connected');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
    this.logger.log('API database disconnected');
  }

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  private assertDatabaseUrl(): void {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required');
    }
  }
}
