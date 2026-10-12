import { Injectable, NotFoundException } from '@nestjs/common';
import { FileBackingType } from '@dochub/database';
import { DatabaseService } from '../database/database.service.js';
import { DrivePreviewService, type DrivePreviewSession } from '../drive/drive-preview.service.js';
import { PreviewService } from './preview.service.js';

export type FileWorkspacePreview =
  | { source: 'LOCAL'; session: Awaited<ReturnType<PreviewService['create']>> }
  | { source: 'GOOGLE_DRIVE'; session: DrivePreviewSession | null };

@Injectable()
export class FileWorkspacePreviewService {
  constructor(
    private readonly database: DatabaseService,
    private readonly local: PreviewService,
    private readonly drive: DrivePreviewService,
  ) {}

  async create(userId: string, nodeId: string): Promise<FileWorkspacePreview> {
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: { type: true, file: { select: { backingType: true } } },
    });
    if (!node || node.type !== 'FILE' || !node.file) throw new NotFoundException('Node not found');
    if (node.file.backingType === FileBackingType.GOOGLE_DRIVE) {
      return { source: 'GOOGLE_DRIVE', session: await this.drive.create(userId, nodeId) };
    }
    return { source: 'LOCAL', session: await this.local.create(userId, nodeId) };
  }
}
