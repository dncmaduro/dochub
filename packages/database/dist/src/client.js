import { PrismaClient } from '@prisma/client';
const globalForPrisma = globalThis;
/**
 * The process-wide Prisma client. Import this instance from application code
 * instead of constructing PrismaClient instances in each consumer.
 */
export const prisma = globalForPrisma.prisma ?? new PrismaClient();
globalForPrisma.prisma = prisma;
export { PrismaClient } from '@prisma/client';
export * from '@prisma/client';
