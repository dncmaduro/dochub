import { createHash, randomUUID } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AuditActorType,
  AuditResult,
  DriveFileLocation,
  DriveFileMigrationStatus,
  DriveFileType,
  DriveSourceStatus,
  FileBackingType,
  EditorMode,
  EditorSessionStatus,
  Prisma,
} from '@dochub/database';
import type { StorageService } from '@dochub/storage';
import { STORAGE_SERVICE } from '../storage/storage.module.js';
import { DatabaseService } from '../database/database.service.js';
import { DriveService, type WritableDriveContext } from './drive.service.js';
import {
  DriveProviderError,
  type DriveApiFile,
} from './google-drive.provider.js';

const LEASE_MS = 15 * 60 * 1000;

export interface DriveMigrationFilters {
  fileId?: string;
  limit?: number;
  after?: string;
  failedOnly?: boolean;
}

export interface MigrationInventoryItem {
  fileId: string;
  nodeId: string;
  path: string;
  name: string;
  backingType: FileBackingType;
  mimeType: string | null;
  storageKey: string | null;
  sizeBytes: string | null;
  sha256: string | null;
  versionNumber: number | null;
  source: string | null;
  currentVersionId: string | null;
  migrationStatus: DriveFileMigrationStatus | null;
  eligibility:
    | 'ELIGIBLE'
    | 'MISSING_CURRENT_VERSION'
    | 'SOURCE_BYTES_MISSING'
    | 'SOURCE_METADATA_MISMATCH'
    | 'ACTIVE_EDITOR'
    | 'ALREADY_PARTIALLY_MIGRATED';
  blockingReason?: string;
}

export interface MigrationInventory {
  totalLocalFiles: number;
  totalGoogleDriveFiles: number;
  items: MigrationInventoryItem[];
  counts: Record<string, number>;
  mimeTypes: Record<string, number>;
  sizeBuckets: Record<string, number>;
  bytesEligible: string;
  bytesBlocked: string;
}

export interface MigrationStatusSummary {
  counts: Record<DriveFileMigrationStatus, number>;
  bytesMigrated: string;
  bytesRemaining: string;
}

interface SourceSnapshot {
  fileId: string;
  nodeId: string;
  nodeName: string;
  parentId: string | null;
  backingType: FileBackingType;
  currentVersionId: string | null;
  version: {
    id: string;
    fileId: string;
    storageKey: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: bigint;
    sha256: string;
  } | null;
}

interface ClaimedMigration {
  id: string;
  fileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  sourceSizeBytes: bigint;
  status: DriveFileMigrationStatus;
  driveIntegrationId: string | null;
  driveFileRecordId: string | null;
  remoteDriveFileId: string | null;
  leaseToken: string;
}

interface HashingStream extends Transform {
  byteCount: number;
  sha256: () => string;
  md5: () => string;
}

@Injectable()
export class DriveFileMigrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly drive: DriveService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async inventory(
    filters: DriveMigrationFilters = {},
  ): Promise<MigrationInventory> {
    const localFiles = await this.database.prisma.file.findMany({
      where: {
        backingType: FileBackingType.LOCAL,
        ...(filters.fileId ? { id: filters.fileId } : {}),
        ...(filters.after ? { id: { gt: filters.after } } : {}),
        ...(filters.failedOnly
          ? {
              driveMigrations: {
                some: {
                  status: {
                    in: [
                      DriveFileMigrationStatus.FAILED,
                      DriveFileMigrationStatus.STALE,
                    ],
                  },
                },
              },
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      ...(filters.limit ? { take: filters.limit } : {}),
      select: {
        id: true,
        nodeId: true,
        backingType: true,
        driveFileId: true,
        currentVersionId: true,
        currentVersion: {
          select: {
            id: true,
            fileId: true,
            storageKey: true,
            originalFilename: true,
            mimeType: true,
            sizeBytes: true,
            sha256: true,
            versionNumber: true,
            source: true,
          },
        },
        node: { select: { id: true, name: true, parentId: true } },
        driveMigrations: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true },
        },
      },
    });
    const nodes = await this.database.prisma.node.findMany({
      select: { id: true, parentId: true, name: true },
    });
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const counts: Record<string, number> = {};
    const mimeTypes: Record<string, number> = {};
    const sizeBuckets: Record<string, number> = {};
    const items: MigrationInventoryItem[] = [];
    let eligibleBytes = 0n;
    let blockedBytes = 0n;

    for (const file of localFiles) {
      const migrationStatus = file.driveMigrations[0]?.status ?? null;
      let eligibility: MigrationInventoryItem['eligibility'] = 'ELIGIBLE';
      let blockingReason: string | undefined;
      let sizeBytes: bigint | null = file.currentVersion?.sizeBytes ?? null;
      if (file.driveFileId) {
        eligibility = 'ALREADY_PARTIALLY_MIGRATED';
        blockingReason = 'LOCAL_FILE_ALREADY_HAS_DRIVE_REFERENCE';
      } else if (!file.currentVersionId || !file.currentVersion) {
        eligibility = 'MISSING_CURRENT_VERSION';
        blockingReason = 'CURRENT_VERSION_MISSING';
      } else if (
        file.currentVersion.id !== file.currentVersionId ||
        file.currentVersion.fileId !== file.id ||
        file.currentVersion.sizeBytes < 0n ||
        !file.currentVersion.sha256 ||
        !file.currentVersion.originalFilename ||
        !file.currentVersion.mimeType
      ) {
        eligibility = 'MISSING_CURRENT_VERSION';
        blockingReason = 'CURRENT_VERSION_METADATA_INVALID';
      } else if (await this.hasActiveEditing(file.id)) {
        eligibility = 'ACTIVE_EDITOR';
        blockingReason = 'ACTIVE_EDIT_SESSION';
      } else {
        try {
          const physical = await this.storage.stat(
            file.currentVersion.storageKey,
          );
          if (physical.sizeBytes !== file.currentVersion.sizeBytes) {
            eligibility = 'SOURCE_METADATA_MISMATCH';
            blockingReason = 'SOURCE_SIZE_MISMATCH';
          }
        } catch {
          eligibility = 'SOURCE_BYTES_MISSING';
          blockingReason = 'SOURCE_BYTES_MISSING';
        }
      }
      if (sizeBytes !== null) {
        const mimeType = file.currentVersion?.mimeType ?? 'UNKNOWN';
        mimeTypes[mimeType] = (mimeTypes[mimeType] ?? 0) + 1;
        const bucket = this.sizeBucket(sizeBytes);
        sizeBuckets[bucket] = (sizeBuckets[bucket] ?? 0) + 1;
      }
      counts[eligibility] = (counts[eligibility] ?? 0) + 1;
      const path = this.nodePath(file.node.id, nodeMap);
      items.push({
        fileId: file.id,
        nodeId: file.nodeId,
        path,
        name: file.node.name,
        backingType: file.backingType,
        mimeType: file.currentVersion?.mimeType ?? null,
        storageKey: file.currentVersion?.storageKey ?? null,
        sizeBytes: sizeBytes?.toString() ?? null,
        sha256: file.currentVersion?.sha256 ?? null,
        versionNumber: file.currentVersion?.versionNumber ?? null,
        source: file.currentVersion?.source ?? null,
        currentVersionId: file.currentVersionId,
        migrationStatus,
        eligibility,
        ...(blockingReason ? { blockingReason } : {}),
      });
      if (sizeBytes !== null) {
        if (eligibility === 'ELIGIBLE') eligibleBytes += sizeBytes;
        else blockedBytes += sizeBytes;
      }
    }

    return {
      totalLocalFiles: await this.database.prisma.file.count({
        where: { backingType: FileBackingType.LOCAL },
      }),
      totalGoogleDriveFiles: await this.database.prisma.file.count({
        where: { backingType: FileBackingType.GOOGLE_DRIVE },
      }),
      items,
      counts,
      mimeTypes,
      sizeBuckets,
      bytesEligible: eligibleBytes.toString(),
      bytesBlocked: blockedBytes.toString(),
    };
  }

  async status(): Promise<MigrationStatusSummary> {
    const rows = await this.database.prisma.driveFileMigration.findMany({
      select: { status: true, sourceSizeBytes: true },
    });
    const localFiles = await this.database.prisma.file.findMany({
      where: { backingType: FileBackingType.LOCAL },
      select: { currentVersion: { select: { sizeBytes: true } } },
    });
    const counts = Object.fromEntries(
      Object.values(DriveFileMigrationStatus).map((status) => [status, 0]),
    ) as Record<DriveFileMigrationStatus, number>;
    let migrated = 0n;
    let remaining = 0n;
    for (const row of rows) {
      counts[row.status] += 1;
      if (row.status === DriveFileMigrationStatus.COMPLETED)
        migrated += row.sourceSizeBytes;
    }
    for (const file of localFiles)
      remaining += file.currentVersion?.sizeBytes ?? 0n;
    return {
      counts,
      bytesMigrated: migrated.toString(),
      bytesRemaining: remaining.toString(),
    };
  }

  async migrate(
    filters: DriveMigrationFilters = {},
  ): Promise<MigrationStatusSummary> {
    const inventory = await this.inventory(filters);
    for (const item of inventory.items) {
      if (item.eligibility !== 'ELIGIBLE') continue;
      await this.migrateFile(item.fileId);
    }
    return this.status();
  }

  async migrateFile(
    fileId: string,
  ): Promise<DriveFileMigrationStatus> {
    const source = await this.loadSource(fileId);
    if (source.backingType !== FileBackingType.LOCAL) {
      return DriveFileMigrationStatus.COMPLETED;
    }
    if (
      !source.currentVersionId ||
      !source.version ||
      source.version.id !== source.currentVersionId ||
      source.version.fileId !== fileId ||
      source.version.sizeBytes < 0n ||
      !source.version.sha256 ||
      !source.version.originalFilename ||
      !source.version.mimeType
    ) {
      await this.recordBlocked(
        fileId,
        source.currentVersionId,
        'MISSING_CURRENT_VERSION',
        'CURRENT_VERSION_METADATA_INVALID',
      );
      return DriveFileMigrationStatus.BLOCKED;
    }
    if (await this.hasActiveEditing(fileId)) {
      await this.recordBlocked(
        fileId,
        source.currentVersionId,
        'ACTIVE_EDITOR',
        'ACTIVE_EDIT_SESSION',
        source.version,
      );
      return DriveFileMigrationStatus.BLOCKED;
    }
    let physicalSize: bigint;
    try {
      physicalSize = (await this.storage.stat(source.version.storageKey))
        .sizeBytes;
    } catch {
      await this.recordBlocked(
        fileId,
        source.currentVersionId,
        'SOURCE_BYTES_MISSING',
        'SOURCE_BYTES_MISSING',
        source.version,
      );
      return DriveFileMigrationStatus.BLOCKED;
    }
    if (physicalSize !== source.version.sizeBytes) {
      await this.recordBlocked(
        fileId,
        source.currentVersionId,
        'SOURCE_METADATA_MISMATCH',
        'SOURCE_SIZE_MISMATCH',
        source.version,
      );
      return DriveFileMigrationStatus.BLOCKED;
    }

    const claim = await this.claim(source);
    if (!claim) return DriveFileMigrationStatus.PENDING;
    let freshRemoteId: string | null = null;
    let localMd5: string | null = null;
    try {
      return await this.drive.withConfiguredWritableDrive(async (context) => {
        if (
          claim.driveIntegrationId &&
          claim.driveIntegrationId !== context.integrationId
        ) {
          throw new ConflictException(
            'Migration is bound to a different company Drive integration',
          );
        }
        let remote: DriveApiFile;
        if (claim.remoteDriveFileId) {
          remote = await this.drive.getFileWithContext(
            context,
            claim.remoteDriveFileId,
          );
        } else {
          const sourceStream = await this.storage.openReadStream(
            source.version!.storageKey,
          );
          const hashing = this.hashingStream();
          const transfer = finished(hashing, { readable: false });
          sourceStream.once('error', (error) => hashing.destroy(error));
          sourceStream.pipe(hashing);
          try {
            remote = await this.drive.uploadBinaryWithContext(
              context,
              source.version!.originalFilename,
              source.version!.mimeType,
              hashing,
            );
            freshRemoteId = remote.id;
            await transfer;
            const sourceDigest = hashing.sha256();
            if (
              hashing.byteCount !== Number(source.version!.sizeBytes) ||
              sourceDigest !== source.version!.sha256
            ) {
              throw new ConflictException(
                'Local source bytes changed during migration',
              );
            }
            localMd5 = hashing.md5();
          } catch (error) {
            sourceStream.destroy();
            hashing.destroy();
            await transfer.catch(() => undefined);
            throw error;
          }
          await this.database.prisma.driveFileMigration.update({
            where: { id: claim.id },
            data: {
              status: DriveFileMigrationStatus.UPLOADED,
              driveIntegrationId: context.integrationId,
              remoteDriveFileId: remote.id,
              uploadedAt: new Date(),
              leaseToken: claim.leaseToken,
              leaseExpiresAt: new Date(Date.now() + LEASE_MS),
              lastErrorCode: null,
              lastErrorSummary: null,
            },
          });
        }
        remote = await this.drive.getFileWithContext(context, remote.id);
        if (localMd5 && remote.md5Checksum && localMd5 !== remote.md5Checksum) {
          throw new ConflictException(
            'Drive checksum does not match the local source',
          );
        }
        await this.database.prisma.driveFileMigration.update({
          where: { id: claim.id },
          data: {
            status: DriveFileMigrationStatus.VERIFYING,
            driveIntegrationId: context.integrationId,
            remoteDriveFileId: remote.id,
            remoteName: remote.name ?? null,
            remoteMimeType: remote.mimeType ?? null,
            remoteSizeBytes: remote.size ? BigInt(remote.size) : null,
            remoteMd5Checksum: remote.md5Checksum ?? null,
            leaseToken: claim.leaseToken,
            leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          },
        });
        this.verifyRemote(source, remote, context.target);
        await this.registerVerified(claim, context, remote);
        // The remote object is now durably registered and verified. A later
        // cutover conflict must not delete a valid migration source.
        freshRemoteId = null;
        return await this.cutover(claim.id, claim.leaseToken);
      });
    } catch (error) {
      if (freshRemoteId) {
        try {
          await this.drive.withConfiguredWritableDrive((context) =>
            this.drive.deleteBinaryWithContext(context, freshRemoteId!),
          );
        } catch (compensationError) {
          if (this.isMissingRemote(compensationError)) {
            freshRemoteId = null;
          } else {
            await this.recordFailure(
              claim.id,
              'REMOTE_ORPHAN',
              'Migration upload completed but cleanup failed; manual reconciliation is required.',
              freshRemoteId,
              error,
              compensationError,
            );
            throw new ServiceUnavailableException(
              'Migration requires Drive reconciliation',
            );
          }
        }
      }
      if (claim.remoteDriveFileId && this.isMissingRemote(error)) {
        await this.database.prisma.driveFileMigration.updateMany({
          where: { id: claim.id },
          data: { remoteDriveFileId: null, driveFileRecordId: null },
        });
      }
      await this.recordFailure(
        claim.id,
        this.errorCode(error),
        this.errorSummary(error),
      );
      throw error;
    }
  }

  async rollback(fileId: string): Promise<DriveFileMigrationStatus> {
    const source = await this.loadSource(fileId);
    const migration = await this.database.prisma.driveFileMigration.findFirst({
      where: { fileId, status: DriveFileMigrationStatus.COMPLETED },
      orderBy: { completedAt: 'desc' },
    });
    if (!migration)
      throw new ConflictException(
        'No completed migration exists for this file',
      );
    if (
      !source.version ||
      source.currentVersionId !== migration.sourceVersionId
    ) {
      throw new ConflictException(
        'The local current version is not the migrated source',
      );
    }
    const hashing = this.hashingStream();
    const stream = await this.storage.openReadStream(source.version.storageKey);
    const transfer = finished(hashing, { readable: false });
    stream.pipe(hashing);
    await transfer;
    if (
      hashing.byteCount !== Number(source.version.sizeBytes) ||
      hashing.sha256() !== source.version.sha256
    ) {
      throw new ConflictException(
        'Local rollback source is unavailable or changed',
      );
    }
    await this.database.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{
          backingType: FileBackingType;
          driveFileId: string | null;
          currentVersionId: string | null;
        }>
      >`
        SELECT "backingType", "driveFileId", "currentVersionId"
        FROM "File" WHERE "id" = ${fileId}::uuid FOR UPDATE`;
      const row = locked[0];
      if (
        !row ||
        row.backingType !== FileBackingType.GOOGLE_DRIVE ||
        row.driveFileId !== migration.driveFileRecordId
      ) {
        throw new ConflictException(
          'File is no longer on the migrated Drive backing',
        );
      }
      if (row.currentVersionId !== migration.sourceVersionId) {
        throw new ConflictException(
          'The local current version changed after migration',
        );
      }
      await tx.file.update({
        where: { id: fileId },
        data: { backingType: FileBackingType.LOCAL, driveFileId: null },
      });
      await tx.driveFileMigration.update({
        where: { id: migration.id },
        data: {
          status: DriveFileMigrationStatus.ROLLED_BACK,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorType: AuditActorType.SYSTEM,
          actorId: null,
          action: 'LOCAL_FILE_MIGRATION_ROLLED_BACK',
          resourceType: 'FILE',
          resourceId: fileId,
          result: AuditResult.SUCCESS,
          metadata: {
            fileId,
            sourceVersionId: migration.sourceVersionId,
            driveFileId: migration.remoteDriveFileId,
          },
        },
      });
    });
    return DriveFileMigrationStatus.ROLLED_BACK;
  }

  private isMissingRemote(error: unknown): boolean {
    return error instanceof DriveProviderError && error.status === 404;
  }

  private async loadSource(fileId: string): Promise<SourceSnapshot> {
    const file = await this.database.prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        nodeId: true,
        backingType: true,
        currentVersionId: true,
        node: { select: { id: true, name: true, parentId: true } },
        currentVersion: {
          select: {
            id: true,
            fileId: true,
            storageKey: true,
            originalFilename: true,
            mimeType: true,
            sizeBytes: true,
            sha256: true,
          },
        },
      },
    });
    if (!file) throw new ConflictException('File not found');
    return {
      fileId: file.id,
      nodeId: file.nodeId,
      nodeName: file.node.name,
      parentId: file.node.parentId,
      backingType: file.backingType,
      currentVersionId: file.currentVersionId,
      version: file.currentVersion,
    };
  }

  private async hasActiveEditing(fileId: string): Promise<boolean> {
    const session = await this.database.prisma.editorSession.findFirst({
      where: {
        fileId,
        mode: EditorMode.EDIT,
        status: EditorSessionStatus.ACTIVE,
        OR: [{ closedAt: null }, { stagedArtifactId: { not: null } }],
      },
      select: { id: true },
    });
    return Boolean(session);
  }

  private async claim(
    source: SourceSnapshot,
  ): Promise<ClaimedMigration | null> {
    const now = new Date();
    const leaseToken = randomUUID();
    try {
      return await this.database.prisma.$transaction(async (tx) => {
        const existing = await tx.driveFileMigration.findUnique({
          where: {
            fileId_sourceVersionId: {
              fileId: source.fileId,
              sourceVersionId: source.currentVersionId!,
            },
          },
        });
        if (existing?.status === DriveFileMigrationStatus.COMPLETED)
          return null;
        if (
          existing &&
          existing.leaseExpiresAt &&
          existing.leaseExpiresAt > now &&
          (existing.status === DriveFileMigrationStatus.UPLOADING ||
            existing.status === DriveFileMigrationStatus.UPLOADED ||
            existing.status === DriveFileMigrationStatus.VERIFYING ||
            existing.status === DriveFileMigrationStatus.VERIFIED)
        )
          return null;
        const migration =
          existing ??
          (await tx.driveFileMigration.create({
            data: {
              fileId: source.fileId,
              sourceVersionId: source.currentVersionId!,
              sourceSha256: source.version!.sha256,
              sourceSizeBytes: source.version!.sizeBytes,
            },
          }));
        const claimed = await tx.driveFileMigration.updateMany({
          where: {
            id: migration.id,
            OR: [
              {
                status: {
                  notIn: [
                    DriveFileMigrationStatus.UPLOADING,
                    DriveFileMigrationStatus.UPLOADED,
                    DriveFileMigrationStatus.VERIFYING,
                    DriveFileMigrationStatus.VERIFIED,
                  ],
                },
              },
              { leaseExpiresAt: null },
              { leaseExpiresAt: { lte: now } },
            ],
          },
          data: {
            status: DriveFileMigrationStatus.UPLOADING,
            attempts: { increment: 1 },
            startedAt: migration.startedAt ?? now,
            failedAt: null,
            leaseToken,
            leaseExpiresAt: new Date(Date.now() + LEASE_MS),
            lastErrorCode: null,
            lastErrorSummary: null,
          },
        });
        if (!claimed.count) return null;
        const updated = await tx.driveFileMigration.findUnique({
          where: { id: migration.id },
        });
        if (!updated) return null;
        await tx.auditLog.create({
          data: {
            actorType: AuditActorType.SYSTEM,
            actorId: null,
            action: 'LOCAL_FILE_MIGRATION_STARTED',
            resourceType: 'FILE',
            resourceId: source.fileId,
            result: AuditResult.SUCCESS,
            metadata: {
              fileId: source.fileId,
              sourceVersionId: source.currentVersionId,
              attempt: updated.attempts,
            },
          },
        });
        return {
          id: updated.id,
          fileId: updated.fileId,
          sourceVersionId: updated.sourceVersionId,
          sourceSha256: updated.sourceSha256,
          sourceSizeBytes: updated.sourceSizeBytes,
          status: updated.status,
          driveIntegrationId: updated.driveIntegrationId,
          driveFileRecordId: updated.driveFileRecordId,
          remoteDriveFileId: updated.remoteDriveFileId,
          leaseToken,
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        return null;
      throw error;
    }
  }

  private async registerVerified(
    claim: ClaimedMigration,
    context: WritableDriveContext,
    remote: DriveApiFile,
  ): Promise<void> {
    await this.database.prisma.$transaction(async (tx) => {
      const stored = await tx.driveFile.upsert({
        where: { driveFileId: remote.id },
        create: this.driveFileData(context.integrationId, remote),
        update: this.driveFileData(context.integrationId, remote),
      });
      const linked = await tx.file.findFirst({
        where: { driveFileId: stored.id, id: { not: claim.fileId } },
        select: { id: true },
      });
      if (linked)
        throw new ConflictException(
          'Drive file is already linked to another Docs Hub file',
        );
      await tx.driveFileMigration.update({
        where: { id: claim.id },
        data: {
          status: DriveFileMigrationStatus.VERIFIED,
          driveIntegrationId: context.integrationId,
          driveFileRecordId: stored.id,
          remoteDriveFileId: remote.id,
          remoteName: remote.name ?? null,
          remoteMimeType: remote.mimeType ?? null,
          remoteSizeBytes: remote.size ? BigInt(remote.size) : null,
          remoteMd5Checksum: remote.md5Checksum ?? null,
          verifiedAt: new Date(),
          leaseToken: claim.leaseToken,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        },
      });
    });
  }

  private async cutover(
    id: string,
    leaseToken: string,
  ): Promise<DriveFileMigrationStatus> {
    return this.database.prisma.$transaction(async (tx) => {
      const migrations = await tx.$queryRaw<
        Array<{
          fileId: string;
          sourceVersionId: string;
          driveFileRecordId: string | null;
          remoteDriveFileId: string | null;
          status: DriveFileMigrationStatus;
        }>
      >`
        SELECT "fileId", "sourceVersionId", "driveFileRecordId", "remoteDriveFileId", "status"
        FROM "DriveFileMigration"
        WHERE "id" = ${id}::uuid AND "leaseToken" = ${leaseToken}::uuid
        FOR UPDATE`;
      const migration = migrations[0];
      if (
        !migration ||
        migration.status !== DriveFileMigrationStatus.VERIFIED ||
        !migration.driveFileRecordId
      ) {
        throw new ConflictException(
          'Migration verification state is unavailable',
        );
      }
      const files = await tx.$queryRaw<
        Array<{
          currentVersionId: string | null;
          backingType: FileBackingType;
          driveFileId: string | null;
        }>
      >`
        SELECT "currentVersionId", "backingType", "driveFileId" FROM "File"
        WHERE "id" = ${migration.fileId}::uuid FOR UPDATE`;
      const file = files[0];
      if (!file) throw new ConflictException('File no longer exists');
      if (file.currentVersionId !== migration.sourceVersionId) {
        await tx.driveFileMigration.update({
          where: { id },
          data: {
            status: DriveFileMigrationStatus.STALE,
            lastErrorCode: 'SOURCE_VERSION_STALE',
            lastErrorSummary:
              'The local current version changed before cutover.',
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        return DriveFileMigrationStatus.STALE;
      }
      const activeEditor = await tx.editorSession.findFirst({
        where: {
          fileId: migration.fileId,
          mode: EditorMode.EDIT,
          status: EditorSessionStatus.ACTIVE,
          OR: [{ closedAt: null }, { stagedArtifactId: { not: null } }],
        },
        select: { id: true },
      });
      if (activeEditor) {
        await tx.driveFileMigration.update({
          where: { id },
          data: {
            status: DriveFileMigrationStatus.BLOCKED,
            lastErrorCode: 'ACTIVE_EDITOR',
            lastErrorSummary: 'An active edit session appeared before cutover.',
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        return DriveFileMigrationStatus.BLOCKED;
      }
      if (
        file.backingType === FileBackingType.GOOGLE_DRIVE &&
        file.driveFileId === migration.driveFileRecordId
      ) {
        await tx.driveFileMigration.update({
          where: { id },
          data: {
            status: DriveFileMigrationStatus.COMPLETED,
            completedAt: new Date(),
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        return DriveFileMigrationStatus.COMPLETED;
      }
      if (file.backingType !== FileBackingType.LOCAL || file.driveFileId) {
        throw new ConflictException(
          'File backing changed before migration cutover',
        );
      }
      await tx.file.update({
        where: { id: migration.fileId },
        data: {
          backingType: FileBackingType.GOOGLE_DRIVE,
          driveFileId: migration.driveFileRecordId,
        },
      });
      await tx.driveFileMigration.update({
        where: { id },
        data: {
          status: DriveFileMigrationStatus.COMPLETED,
          completedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorType: AuditActorType.SYSTEM,
          actorId: null,
          action: 'LOCAL_FILE_MIGRATION_COMPLETED',
          resourceType: 'FILE',
          resourceId: migration.fileId,
          result: AuditResult.SUCCESS,
          metadata: {
            fileId: migration.fileId,
            sourceVersionId: migration.sourceVersionId,
            driveFileId: migration.remoteDriveFileId,
          },
        },
      });
      return DriveFileMigrationStatus.COMPLETED;
    });
  }

  private async recordBlocked(
    fileId: string,
    sourceVersionId: string | null,
    code: string,
    summary: string,
    source?: { sha256: string; sizeBytes: bigint } | null,
  ): Promise<void> {
    if (!sourceVersionId) return;
    await this.database.prisma.driveFileMigration.upsert({
      where: { fileId_sourceVersionId: { fileId, sourceVersionId } },
      create: {
        fileId,
        sourceVersionId,
        sourceSha256: source?.sha256 ?? '',
        sourceSizeBytes: source?.sizeBytes ?? 0n,
        status: DriveFileMigrationStatus.BLOCKED,
        lastErrorCode: code,
        lastErrorSummary: summary,
        failedAt: new Date(),
      },
      update: {
        status: DriveFileMigrationStatus.BLOCKED,
        lastErrorCode: code,
        lastErrorSummary: summary,
        failedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  }

  private async recordFailure(
    id: string,
    code: string,
    summary: string,
    remoteDriveFileId?: string,
    cause?: unknown,
    compensationError?: unknown,
  ): Promise<void> {
    await this.database.prisma.driveFileMigration.updateMany({
      where: { id },
      data: {
        status: DriveFileMigrationStatus.FAILED,
        lastErrorCode: code,
        lastErrorSummary: summary,
        failedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        ...(remoteDriveFileId ? { remoteDriveFileId } : {}),
      },
    });
    await this.database.prisma.auditLog.create({
      data: {
        actorType: AuditActorType.SYSTEM,
        actorId: null,
        action: 'LOCAL_FILE_MIGRATION_FAILED',
        resourceType: 'MIGRATION',
        resourceId: id,
        result: AuditResult.FAILED,
        metadata: {
          error: summary,
          cause: this.errorSummary(cause),
          compensationError: this.errorSummary(compensationError),
          remoteDriveFileId,
        },
      },
    });
  }

  private verifyRemote(
    source: SourceSnapshot,
    remote: DriveApiFile,
    target: WritableDriveContext['target'],
  ): void {
    if (!remote.id)
      throw new ConflictException('Drive did not return a file ID');
    if (remote.name !== source.version?.originalFilename)
      throw new ConflictException('Drive returned an unexpected file name');
    if (remote.mimeType !== source.version?.mimeType)
      throw new ConflictException('Drive returned an unexpected MIME type');
    if (
      remote.size === undefined ||
      BigInt(remote.size) !== source.version?.sizeBytes
    )
      throw new ConflictException('Drive returned an unexpected file size');
    if (remote.trashed)
      throw new ConflictException('Drive returned a trashed file');
    if (
      target.parentFolderId &&
      !remote.parents?.includes(target.parentFolderId)
    )
      throw new ConflictException('Drive returned an unexpected parent folder');
  }

  private driveFileData(
    integrationId: string,
    remote: DriveApiFile,
  ): Prisma.DriveFileUncheckedCreateInput {
    return {
      driveIntegrationId: integrationId,
      driveFileId: remote.id,
      name: remote.name ?? '(unnamed Drive file)',
      mimeType: remote.mimeType ?? 'application/octet-stream',
      normalizedType: this.normalizeType(remote.mimeType),
      webViewLink: remote.webViewLink ?? null,
      driveModifiedTime: this.safeDate(remote.modifiedTime),
      driveCreatedTime: this.safeDate(remote.createdTime),
      trashed: remote.trashed === true,
      driveParents: remote.parents ?? [],
      location: remote.driveId
        ? DriveFileLocation.SHARED_DRIVE
        : DriveFileLocation.MY_DRIVE,
      sharedDriveId: remote.driveId ?? null,
      sizeBytes: remote.size ? BigInt(remote.size) : null,
      driveVersion: remote.version ?? null,
      sourceStatus: remote.trashed
        ? DriveSourceStatus.UNAVAILABLE
        : DriveSourceStatus.CONNECTED,
      syncedAt: new Date(),
    };
  }

  private normalizeType(mimeType: string | undefined): DriveFileType {
    switch (mimeType) {
      case 'application/pdf':
        return DriveFileType.PDF;
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return DriveFileType.DOCX;
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        return DriveFileType.XLSX;
      case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        return DriveFileType.PPTX;
      default:
        if (mimeType?.startsWith('image/')) return DriveFileType.IMAGE;
        if (mimeType?.startsWith('video/')) return DriveFileType.VIDEO;
        return DriveFileType.BINARY;
    }
  }

  private hashingStream(): HashingStream {
    const sha = createHash('sha256');
    const md5 = createHash('md5');
    let byteCount = 0;
    let shaDigest: string | undefined;
    let md5Digest: string | undefined;
    const stream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        byteCount += chunk.length;
        sha.update(chunk);
        md5.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        shaDigest = sha.digest('hex');
        md5Digest = md5.digest('hex');
        callback();
      },
    }) as HashingStream;
    stream.byteCount = byteCount;
    Object.defineProperty(stream, 'byteCount', { get: () => byteCount });
    stream.sha256 = () => shaDigest ?? sha.copy().digest('hex');
    stream.md5 = () => md5Digest ?? md5.copy().digest('hex');
    return stream;
  }

  private nodePath(
    nodeId: string,
    nodes: Map<string, { id: string; parentId: string | null; name: string }>,
  ): string {
    const names: string[] = [];
    const seen = new Set<string>();
    let current: string | null = nodeId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const node = nodes.get(current);
      if (!node) break;
      names.unshift(node.name);
      current = node.parentId;
    }
    return `/${names.join('/')}`;
  }

  private sizeBucket(size: bigint): string {
    if (size < 1024n * 1024n) return '<1MiB';
    if (size < 100n * 1024n * 1024n) return '1-100MiB';
    if (size < 512n * 1024n * 1024n) return '100-512MiB';
    return '>=512MiB';
  }

  private errorCode(error: unknown): string {
    if (error instanceof DriveProviderError)
      return `DRIVE_${error.kind.toUpperCase()}`;
    if (error instanceof ConflictException) return 'CONFLICT';
    return 'MIGRATION_ERROR';
  }

  private errorSummary(error: unknown): string {
    if (error instanceof DriveProviderError) {
      if (error.kind === 'rate_limited')
        return 'Google Drive rate limited the migration.';
      if (error.kind === 'network') return 'Google Drive could not be reached.';
      return `Google Drive ${error.kind} error.`;
    }
    if (error instanceof Error && error.message)
      return error.message.slice(0, 500);
    return 'Migration failed.';
  }

  private safeDate(value: string | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
