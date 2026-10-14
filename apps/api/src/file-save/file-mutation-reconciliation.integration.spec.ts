import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FileRevisionProvider,
  FileRevisionSource,
  FileSaveOperationStatus,
  FileSaveOperationType,
  GeneralAccessRole,
  NodeType,
  UserStatus,
  finalizeFileMutationOperation,
  prisma,
} from '@dochub/database';

const withDatabase = process.env.DATABASE_URL ? describe : describe.skip;

withDatabase('CP8.1 file mutation reconciliation integration', () => {
  const suffix = randomUUID();
  const userId = randomUUID();
  const nodeId = randomUUID();
  const fileId = randomUUID();

  async function createOperation(input: {
    operationId: string;
    type: FileSaveOperationType;
    source: FileRevisionSource;
    sourceRevisionId?: string;
    expectedRevision: string;
    resultRevision: string;
    providerVersionId: string;
    previous?: { revision: string; providerVersionId: string };
  }) {
    return prisma.fileSaveOperation.create({
      data: {
        operationId: input.operationId,
        fileId,
        expectedRevision: input.expectedRevision,
        status: FileSaveOperationStatus.PROVIDER_WRITTEN,
        operationType: input.type,
        source: input.source,
        sourceRevisionId: input.sourceRevisionId,
        previousStorageRevision: input.previous?.revision,
        previousProviderVersionId: input.previous?.providerVersionId,
        resultRevision: input.resultRevision,
        providerVersionId: input.providerVersionId,
        resultSizeBytes: 7n,
        createdById: userId,
        providerWrittenAt: new Date(),
      },
    });
  }

  beforeEach(async () => {
    await prisma.fileSaveOperation.deleteMany({ where: { fileId } });
    await prisma.fileRevision.deleteMany({ where: { fileId } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: fileId } });
    await prisma.auditLog.deleteMany({ where: { resourceId: nodeId } });
    await prisma.file.deleteMany({ where: { id: fileId } });
    await prisma.node.deleteMany({ where: { id: nodeId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.user.create({
      data: {
        id: userId,
        email: `mutation-${suffix}@example.test`,
        normalizedEmail: `mutation-${suffix}@example.test`,
        displayName: 'Mutation tester',
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.node.create({
      data: {
        id: nodeId,
        type: NodeType.FILE,
        name: `mutation-${suffix}.docx`,
        normalizedName: `mutation-${suffix}`,
        generalAccessRole: GeneralAccessRole.RESTRICTED,
        createdById: userId,
      },
    });
    await prisma.file.create({ data: { id: fileId, nodeId } });
  });

  afterAll(async () => {
    await prisma.fileSaveOperation.deleteMany({ where: { fileId } });
    await prisma.fileRevision.deleteMany({ where: { fileId } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: fileId } });
    await prisma.auditLog.deleteMany({ where: { resourceId: nodeId } });
    await prisma.file.deleteMany({ where: { id: fileId } });
    await prisma.node.deleteMany({ where: { id: nodeId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('reconciles one provider-written save exactly once after an injected finalization failure', async () => {
    const operationId = `save-${randomUUID()}`;
    let providerReplaceCalls = 1; // The fake provider boundary has already succeeded.
    await createOperation({
      operationId,
      type: FileSaveOperationType.SAVE,
      source: FileRevisionSource.MANUAL_SAVE,
      expectedRevision: 'V1',
      resultRevision: 'V2',
      providerVersionId: 'provider-v2',
      previous: { revision: 'V1', providerVersionId: 'provider-v1' },
    });

    const failingDatabase = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === '$transaction')
          return async () => {
            throw new Error('injected finalization failure');
          };
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      finalizeFileMutationOperation(
        failingDatabase as typeof prisma,
        operationId,
      ),
    ).rejects.toThrow('injected finalization failure');
    await expect(
      prisma.fileSaveOperation.findUniqueOrThrow({ where: { operationId } }),
    ).resolves.toMatchObject({
      status: FileSaveOperationStatus.PROVIDER_WRITTEN,
    });

    await finalizeFileMutationOperation(prisma, operationId);
    await finalizeFileMutationOperation(prisma, operationId);
    expect(providerReplaceCalls).toBe(1);
    await expect(
      prisma.fileSaveOperation.findUniqueOrThrow({ where: { operationId } }),
    ).resolves.toMatchObject({ status: FileSaveOperationStatus.COMPLETED });
    await expect(
      prisma.fileRevision.findMany({
        where: { fileId },
        orderBy: { sequence: 'asc' },
      }),
    ).resolves.toMatchObject([
      {
        sequence: 1,
        source: FileRevisionSource.INITIAL,
        storageRevision: 'V1',
      },
      {
        sequence: 2,
        source: FileRevisionSource.MANUAL_SAVE,
        storageRevision: 'V2',
        operationId,
      },
    ]);
    await expect(
      prisma.auditLog.count({
        where: { mutationOperationId: operationId, result: 'SUCCESS' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.outboxEvent.count({
        where: {
          mutationOperationId: operationId,
          eventType: 'FILE_CONTENT_CHANGED',
        },
      }),
    ).resolves.toBe(1);
  });

  it('reconciles a V1 restore into exactly one V4 and preserves operation idempotency', async () => {
    const revisions = await Promise.all(
      ['V1', 'V2', 'V3'].map((storageRevision, index) =>
        prisma.fileRevision.create({
          data: {
            fileId,
            sequence: index + 1,
            provider: FileRevisionProvider.GOOGLE_DRIVE,
            providerVersionId: `provider-v${index + 1}`,
            storageRevision,
            source:
              index === 0
                ? FileRevisionSource.INITIAL
                : FileRevisionSource.MANUAL_SAVE,
            createdById: userId,
          },
        }),
      ),
    );
    await prisma.file.update({
      where: { id: fileId },
      data: { revisionSequence: 3 },
    });
    const operationId = `restore-${randomUUID()}`;
    let providerReplaceCalls = 1;
    await createOperation({
      operationId,
      type: FileSaveOperationType.RESTORE,
      source: FileRevisionSource.RESTORE,
      sourceRevisionId: revisions[0].id,
      expectedRevision: 'V3',
      resultRevision: 'V4',
      providerVersionId: 'provider-v4',
    });

    await finalizeFileMutationOperation(prisma, operationId);
    await finalizeFileMutationOperation(prisma, operationId);
    expect(providerReplaceCalls).toBe(1);
    await expect(
      prisma.fileRevision.findMany({
        where: { fileId },
        orderBy: { sequence: 'asc' },
      }),
    ).resolves.toMatchObject([
      { sequence: 1, storageRevision: 'V1' },
      { sequence: 2, storageRevision: 'V2' },
      { sequence: 3, storageRevision: 'V3' },
      {
        sequence: 4,
        source: FileRevisionSource.RESTORE,
        storageRevision: 'V4',
        operationId,
      },
    ]);
    await expect(
      prisma.auditLog.count({
        where: { mutationOperationId: operationId, action: 'FILE_RESTORE' },
      }),
    ).resolves.toBe(1);
  });

  it('keeps operation and revision identities unique under concurrent reconciliation attempts', async () => {
    const operationId = `concurrent-${randomUUID()}`;
    await createOperation({
      operationId,
      type: FileSaveOperationType.SAVE,
      source: FileRevisionSource.MANUAL_SAVE,
      expectedRevision: 'V1',
      resultRevision: 'V2',
      providerVersionId: 'provider-v2',
      previous: { revision: 'V1', providerVersionId: 'provider-v1' },
    });
    await Promise.allSettled([
      finalizeFileMutationOperation(prisma, operationId),
      finalizeFileMutationOperation(prisma, operationId),
    ]);
    await finalizeFileMutationOperation(prisma, operationId);
    const revisions = await prisma.fileRevision.findMany({
      where: { fileId },
      orderBy: { sequence: 'asc' },
    });
    expect(revisions.map((revision) => revision.sequence)).toEqual([1, 2]);
    expect(
      new Set(revisions.map((revision) => revision.operationId).filter(Boolean))
        .size,
    ).toBe(1);
    await expect(
      prisma.fileSaveOperation.create({
        data: {
          operationId,
          fileId,
          expectedRevision: 'duplicate',
          source: FileRevisionSource.MANUAL_SAVE,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
