import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditActorType,
  AuditResult,
  FileBackingType,
  NodeType,
  Prisma,
} from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { FolderAccessService } from '../authorization/folder-access.service.js';
import { normalizeNodeName } from '../nodes/node-name.js';
import type { AddToDocsHubDto } from './dto/add-to-docshub.dto.js';
import { DriveService } from './drive.service.js';

@Injectable()
export class DriveOrganizationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    private readonly folders: FolderAccessService,
    private readonly drive: DriveService,
  ) {}

  async addToDocsHub(
    actorUserId: string,
    driveFileId: string,
    dto: AddToDocsHubDto,
  ) {
    const parentId = dto.parentId ?? null;
    try {
      const prepared = await this.drive.prepareDriveFileForImport(
        actorUserId,
        driveFileId,
      );
      return await this.database.prisma.$transaction(
        async (transaction) => {
          await this.authorization.assertDocumentManager(actorUserId, transaction);
          await this.requireDestination(actorUserId, parentId, transaction);
          const driveFile = prepared.driveFile;

          const existing = await transaction.file.findUnique({
            where: { driveFileId: driveFile.id },
            select: { nodeId: true },
          });
          if (existing) {
            throw new ConflictException('Drive file is already in Docs Hub');
          }

          const name = normalizeNodeName(driveFile.name);
          const conflictingNode = await transaction.node.findFirst({
            where: {
              parentId,
              normalizedName: name.normalizedName,
              trashOperationId: null,
            },
            select: { id: true },
          });
          if (conflictingNode) {
            throw new ConflictException('A node with this name already exists');
          }

          const node = await transaction.node.create({
            data: {
              parentId,
              type: NodeType.FILE,
              name: name.name,
              normalizedName: name.normalizedName,
              createdById: actorUserId,
              updatedById: actorUserId,
            },
            select: { id: true, parentId: true, name: true },
          });
          const file = await transaction.file.create({
            data: {
              nodeId: node.id,
              backingType: FileBackingType.GOOGLE_DRIVE,
              driveFileId: driveFile.id,
            },
            select: { id: true },
          });
          await transaction.auditLog.create({
            data: {
              actorType: AuditActorType.USER,
              actorId: actorUserId,
              action: 'DRIVE_FILE_ADDED_TO_DOCSHUB',
              resourceType: 'NODE',
              resourceId: node.id,
              result: AuditResult.SUCCESS,
              metadata: {
                driveFileId: driveFile.driveFileId,
                parentId,
              },
            },
          });
          return {
            nodeId: node.id,
            fileId: file.id,
            driveFileId: driveFile.driveFileId,
            parentId: node.parentId,
            name: node.name,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('Drive file is already in Docs Hub');
      }
      throw error;
    }
  }

  async removeFromDocsHub(actorUserId: string, nodeId: string) {
    return this.database.prisma.$transaction(async (transaction) => {
      await this.authorization.assertDocumentManager(actorUserId, transaction);
      const node = await transaction.node.findFirst({
        where: { id: nodeId, trashOperationId: null },
        select: {
          id: true,
          type: true,
          file: {
            select: {
              id: true,
              backingType: true,
              driveFile: { select: { driveFileId: true } },
            },
          },
        },
      });
      if (
        !node ||
        node.type !== NodeType.FILE ||
        !node.file ||
        node.file.backingType !== FileBackingType.GOOGLE_DRIVE ||
        !node.file.driveFile
      ) {
        throw new NotFoundException('Drive-backed Docs Hub file not found');
      }

      await transaction.file.delete({ where: { id: node.file.id } });
      await transaction.node.delete({ where: { id: node.id } });
      await transaction.auditLog.create({
        data: {
          actorType: AuditActorType.USER,
          actorId: actorUserId,
          action: 'DRIVE_FILE_REMOVED_FROM_DOCSHUB',
          resourceType: 'NODE',
          resourceId: node.id,
          result: AuditResult.SUCCESS,
          metadata: { driveFileId: node.file.driveFile.driveFileId },
        },
      });
      return { nodeId, removed: true };
    });
  }

  private async requireDestination(
    actorUserId: string,
    parentId: string | null,
    transaction: Prisma.TransactionClient,
  ): Promise<void> {
    const destination = await this.folders.resolve(
      actorUserId,
      parentId,
      transaction,
    );
    if (
      destination.node &&
      (destination.node.type !== NodeType.FOLDER ||
        !destination.capabilities.has(DocumentCapability.VIEW))
    ) {
      throw new NotFoundException('Destination folder not found');
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}
