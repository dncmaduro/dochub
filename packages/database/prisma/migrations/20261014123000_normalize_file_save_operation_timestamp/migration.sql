-- FileSaveOperation.updatedAt was introduced as a wall-clock timestamp.
-- Store it as an absolute instant so Prisma and PostgreSQL share the same
-- stale-reconciliation semantics regardless of the session timezone.
ALTER TABLE "FileSaveOperation"
  ALTER COLUMN "updatedAt" TYPE TIMESTAMP(3) WITH TIME ZONE
  USING "updatedAt" AT TIME ZONE 'UTC';
