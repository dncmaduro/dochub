import { afterAll, afterEach, beforeEach } from 'vitest';
import { PrismaClient } from '@dochub/database';

const url = process.env.WORKER_TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'WORKER_TEST_DATABASE_URL is required for worker integration tests',
  );

process.env.DATABASE_URL = url;
const database = new PrismaClient({ datasources: { db: { url } } });

async function resetWorkerTestDatabase(): Promise<void> {
  await database.$executeRawUnsafe(`
    DO $$
    DECLARE tables text;
    BEGIN
      SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
      INTO tables
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations';
      IF tables IS NOT NULL THEN
        EXECUTE 'TRUNCATE TABLE ' || tables || ' RESTART IDENTITY CASCADE';
      END IF;
    END $$;
  `);
}

beforeEach(resetWorkerTestDatabase);
afterEach(resetWorkerTestDatabase);
afterAll(async () => database.$disconnect());
