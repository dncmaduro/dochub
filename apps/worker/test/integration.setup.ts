import { PrismaClient } from '@dochub/database';

function workerTestDatabaseUrl(): string {
  const value = process.env.WORKER_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'WORKER_TEST_DATABASE_URL is required for worker integration tests',
    );

  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!databaseName.endsWith('_worker_test'))
    throw new Error(
      'WORKER_TEST_DATABASE_URL must target a dedicated database ending in _worker_test',
    );
  return value;
}

async function resetWorkerTestDatabase(database: PrismaClient): Promise<void> {
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

export default async function workerIntegrationSetup() {
  const url = workerTestDatabaseUrl();
  process.env.DATABASE_URL = url;
  const database = new PrismaClient({ datasources: { db: { url } } });
  await resetWorkerTestDatabase(database);

  return async () => {
    await resetWorkerTestDatabase(database);
    await database.$disconnect();
  };
}
