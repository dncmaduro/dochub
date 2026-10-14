import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FileRevisionSource,
  FileSaveOperationStatus,
  FileSaveOperationType,
  GeneralAccessRole,
  NodeType,
  PrismaClient,
  UserStatus,
} from '@dochub/database';
import { FileMutationReconciliationService } from '../src/file-mutation-reconciliation/file-mutation-reconciliation.service.js';

const database = new PrismaClient({
  datasources: { db: { url: process.env.WORKER_TEST_DATABASE_URL } },
});

async function providerWrittenOperation(input: {
  stale?: boolean;
  status?: FileSaveOperationStatus;
}) {
  const suffix = randomUUID();
  const user = await database.user.create({
    data: {
      email: `worker-${suffix}@example.test`,
      normalizedEmail: `worker-${suffix}@example.test`,
      displayName: 'Worker tester',
      status: UserStatus.ACTIVE,
    },
  });
  const node = await database.node.create({
    data: {
      type: NodeType.FILE,
      name: `worker-${suffix}`,
      normalizedName: `worker-${suffix}`,
      generalAccessRole: GeneralAccessRole.RESTRICTED,
      createdById: user.id,
    },
  });
  const file = await database.file.create({ data: { nodeId: node.id } });
  const operationId = `worker-${randomUUID()}`;
  const operation = await database.fileSaveOperation.create({
    data: {
      operationId,
      fileId: file.id,
      expectedRevision: 'V1',
      status: input.status ?? FileSaveOperationStatus.PROVIDER_WRITTEN,
      operationType: FileSaveOperationType.SAVE,
      source: FileRevisionSource.MANUAL_SAVE,
      previousStorageRevision: 'V1',
      previousProviderVersionId: `provider-${suffix}-1`,
      resultRevision: 'V2',
      providerVersionId: `provider-${suffix}-2`,
      resultSizeBytes: 7n,
      createdById: user.id,
      providerWrittenAt: new Date(),
    },
  });
  if (input.stale !== false)
    await database.$executeRaw`UPDATE "FileSaveOperation" SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE "id" = ${operation.id}::uuid`;
  return { operationId, fileId: file.id };
}

function worker(client: PrismaClient = database) {
  return new FileMutationReconciliationService(client, {
    enabled: true,
    pollSeconds: 60,
    staleSeconds: 60,
    batchSize: 20,
  });
}

describe('FileMutationReconciliationService integration', () => {
  it('selects and completes stale PROVIDER_WRITTEN work while ignoring recent and PENDING records', async () => {
    const stale = await providerWrittenOperation({});
    const recent = await providerWrittenOperation({ stale: false });
    const pending = await providerWrittenOperation({
      status: FileSaveOperationStatus.PENDING,
    });
    await expect(worker().runCycle()).resolves.toBe(2);
    await expect(
      database.fileSaveOperation.findUniqueOrThrow({
        where: { operationId: stale.operationId },
      }),
    ).resolves.toMatchObject({ status: FileSaveOperationStatus.COMPLETED });
    await expect(
      database.fileSaveOperation.findUniqueOrThrow({
        where: { operationId: recent.operationId },
      }),
    ).resolves.toMatchObject({
      status: FileSaveOperationStatus.PROVIDER_WRITTEN,
    });
    await expect(
      database.fileSaveOperation.findUniqueOrThrow({
        where: { operationId: pending.operationId },
      }),
    ).resolves.toMatchObject({ status: FileSaveOperationStatus.PENDING });
  });

  it('keeps a transient finalization failure reconcilable and completes it on the next cycle', async () => {
    const target = await providerWrittenOperation({});
    let failOnce = true;
    const transientDatabase = new Proxy(database, {
      get(source, property, receiver) {
        if (property === '$transaction')
          return async (...args: unknown[]) => {
            if (failOnce) {
              failOnce = false;
              throw new Error('temporary database failure');
            }
            return (
              source.$transaction as (...transactionArgs: unknown[]) => unknown
            )(...args);
          };
        const value = Reflect.get(source, property, receiver);
        return typeof value === 'function' ? value.bind(source) : value;
      },
    });
    await expect(
      worker(transientDatabase as PrismaClient).runCycle(),
    ).resolves.toBe(1);
    await expect(
      database.fileSaveOperation.findUniqueOrThrow({
        where: { operationId: target.operationId },
      }),
    ).resolves.toMatchObject({
      status: FileSaveOperationStatus.PROVIDER_WRITTEN,
      finalizationAttempts: 1,
    });
    // A failed attempt updates the record. It becomes eligible again after the
    // configured stale interval; move the test clock boundary explicitly.
    await database.$executeRaw`UPDATE "FileSaveOperation" SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE "operationId" = ${target.operationId}`;
    await expect(
      worker(transientDatabase as PrismaClient).runCycle(),
    ).resolves.toBe(1);
    await expect(
      database.fileSaveOperation.findUniqueOrThrow({
        where: { operationId: target.operationId },
      }),
    ).resolves.toMatchObject({ status: FileSaveOperationStatus.COMPLETED });
  });
});
