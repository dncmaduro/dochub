import {
  FileRevisionProvider,
  FileRevisionSource,
  FileSaveOperationStatus,
  FileSaveOperationType,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

export interface FinalizedFileMutation {
  operationId: string;
  storageRevision: string;
  fileRevisionId: string;
  sequence: number;
}

/**
 * Completes only database effects for an already-written provider mutation.
 * It deliberately has no StorageProvider dependency: a retry or worker must
 * never use reconciliation as an opportunity to write provider bytes again.
 */
export async function finalizeFileMutationOperation(
  database: PrismaClient,
  operationId: string,
): Promise<FinalizedFileMutation> {
  return database.$transaction(async (tx) => {
    const operation = await tx.fileSaveOperation.findUniqueOrThrow({
      where: { operationId },
      include: {
        file: { select: { id: true, nodeId: true, driveFileId: true } },
      },
    });

    if (!operation.resultRevision || !operation.providerVersionId) {
      throw new Error(`Mutation ${operationId} has no durable provider result.`);
    }
    if (
      operation.status !== FileSaveOperationStatus.PROVIDER_WRITTEN &&
      operation.status !== FileSaveOperationStatus.COMPLETED
    ) {
      throw new Error(`Mutation ${operationId} is not ready for finalization.`);
    }

    let revision = await tx.fileRevision.findUnique({
      where: { operationId },
    });
    if (!revision) {
      if (
        operation.operationType === FileSaveOperationType.SAVE &&
        (await tx.fileRevision.count({ where: { fileId: operation.fileId } })) === 0
      ) {
        if (
          !operation.previousStorageRevision ||
          !operation.previousProviderVersionId
        ) {
          throw new Error(`Save mutation ${operationId} is missing its baseline version.`);
        }
        const initial = await tx.file.update({
          where: { id: operation.fileId },
          data: { revisionSequence: { increment: 1 } },
          select: { revisionSequence: true },
        });
        await tx.fileRevision.create({
          data: {
            fileId: operation.fileId,
            sequence: initial.revisionSequence,
            provider: FileRevisionProvider.GOOGLE_DRIVE,
            providerVersionId: operation.previousProviderVersionId,
            storageRevision: operation.previousStorageRevision,
            sizeBytes: operation.previousSizeBytes,
            checksum: operation.previousChecksum,
            source: FileRevisionSource.INITIAL,
            createdById: operation.createdById,
          },
        });
      }

      const next = await tx.file.update({
        where: { id: operation.fileId },
        data: { revisionSequence: { increment: 1 } },
        select: { revisionSequence: true },
      });
      revision = await tx.fileRevision.create({
        data: {
          fileId: operation.fileId,
          sequence: next.revisionSequence,
          provider: FileRevisionProvider.GOOGLE_DRIVE,
          providerVersionId: operation.providerVersionId,
          storageRevision: operation.resultRevision,
          sizeBytes: operation.resultSizeBytes,
          checksum: operation.resultChecksum,
          source: operation.source,
          operationId,
          createdById: operation.createdById,
        },
      });
    }

    if (operation.file.driveFileId) {
      await tx.driveFile.update({
        where: { id: operation.file.driveFileId },
        data: {
          sizeBytes: operation.resultSizeBytes,
          driveVersion: operation.resultRevision,
          syncedAt: new Date(),
        },
      });
    }
    await tx.node.update({
      where: { id: operation.file.nodeId },
      data: { updatedById: operation.createdById },
    });

    const isRestore = operation.operationType === FileSaveOperationType.RESTORE;
    await tx.auditLog.upsert({
      where: { mutationOperationId: operationId },
      update: {},
      create: {
        mutationOperationId: operationId,
        actorType: 'USER',
        actorId: operation.createdById,
        action: isRestore ? 'FILE_RESTORE' : 'FILE_SAVE',
        resourceType: 'NODE',
        resourceId: operation.file.nodeId,
        result: 'SUCCESS',
        metadata: {
          fileId: operation.fileId,
          sourceRevisionId: operation.sourceRevisionId,
          resultRevision: operation.resultRevision,
          operationId,
        },
      },
    });
    await tx.outboxEvent.upsert({
      where: { mutationOperationId: operationId },
      update: {},
      create: {
        mutationOperationId: operationId,
        eventType: 'FILE_CONTENT_CHANGED',
        aggregateType: 'FILE',
        aggregateId: operation.fileId,
        payload: {
          fileId: operation.fileId,
          storageRevision: operation.resultRevision,
          source: operation.source,
          operationId,
        },
      },
    });
    await tx.fileSaveOperation.update({
      where: { operationId },
      data: {
        status: FileSaveOperationStatus.COMPLETED,
        completedAt: operation.completedAt ?? new Date(),
        finalizationAttempts: { increment: 1 },
        lastFinalizationError: null,
      },
    });
    return {
      operationId,
      storageRevision: operation.resultRevision,
      fileRevisionId: revision.id,
      sequence: revision.sequence,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
