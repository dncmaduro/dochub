import { PrismaClient } from '@prisma/client';
/**
 * The process-wide Prisma client. Import this instance from application code
 * instead of constructing PrismaClient instances in each consumer.
 */
export declare const prisma: PrismaClient<import("@prisma/client").Prisma.PrismaClientOptions, never, import("@prisma/client/runtime/library").DefaultArgs>;
export { PrismaClient } from '@prisma/client';
export * from '@prisma/client';
