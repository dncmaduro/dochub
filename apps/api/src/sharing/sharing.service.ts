import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, AuditResult, Prisma } from '@dochub/database';
import { AUTH_CONFIG, type AuthConfig } from '../auth/auth.config.js';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { UpdateSharingDto } from './dto/update-sharing.dto.js';
import { createShareLinkSecret } from './share-link-secret.js';
import type { ShareLinkResponse, SharingState } from './sharing.types.js';

const SERIALIZATION_RETRIES = 3;
type SharingAction =
  | 'SHARE_LINK_CREATED'
  | 'SHARE_LINK_RESET'
  | 'SHARE_LINK_REVOKED'
  | 'PUBLIC_ACCESS_CHANGED';

@Injectable()
export class SharingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async getState(actorId: string, nodeId: string): Promise<SharingState> {
    return this.withSerializableRetry(async (tx) => {
      const { node, canManageSharing } = await this.requireNode(
        actorId,
        nodeId,
        tx,
        false,
      );
      const link = await this.activeLink(nodeId, tx);
      return {
        nodeId,
        publicAccess: node.publicAccess,
        shareLink: { exists: !!link },
        canManageSharing,
      };
    });
  }

  async ensureLink(
    actorId: string,
    nodeId: string,
  ): Promise<ShareLinkResponse> {
    return this.withSerializableRetry(async (tx) => {
      await this.requireNode(actorId, nodeId, tx, true);
      const existing = await this.activeLink(nodeId, tx);
      if (existing) {
        return {
          nodeId,
          shareLink: { id: existing.id, created: false, url: null },
        };
      }
      return this.createLink(actorId, nodeId, 'SHARE_LINK_CREATED', tx);
    });
  }

  async resetLink(actorId: string, nodeId: string): Promise<ShareLinkResponse> {
    return this.withSerializableRetry(async (tx) => {
      await this.requireNode(actorId, nodeId, tx, true);
      await tx.shareLink.updateMany({
        where: { nodeId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return this.createLink(actorId, nodeId, 'SHARE_LINK_RESET', tx);
    });
  }

  async revokeLink(actorId: string, nodeId: string): Promise<void> {
    await this.withSerializableRetry(async (tx) => {
      await this.requireNode(actorId, nodeId, tx, true);
      const existing = await this.activeLink(nodeId, tx);
      if (!existing) return;
      await tx.shareLink.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
      await this.audit(
        actorId,
        nodeId,
        'SHARE_LINK_REVOKED',
        { shareLinkId: existing.id },
        tx,
      );
    });
  }

  async updatePublicAccess(
    actorId: string,
    nodeId: string,
    dto: UpdateSharingDto,
  ): Promise<{ nodeId: string; publicAccess: boolean }> {
    return this.withSerializableRetry(async (tx) => {
      const { node } = await this.requireNode(actorId, nodeId, tx, true);
      if (node.publicAccess !== dto.publicAccess) {
        await tx.node.update({
          where: { id: nodeId },
          data: { publicAccess: dto.publicAccess },
        });
        await this.audit(
          actorId,
          nodeId,
          'PUBLIC_ACCESS_CHANGED',
          {
            previousPublicAccess: node.publicAccess,
            publicAccess: dto.publicAccess,
          },
          tx,
        );
      }
      return { nodeId, publicAccess: dto.publicAccess };
    });
  }

  private async requireNode(
    actorId: string,
    nodeId: string,
    tx: Prisma.TransactionClient,
    mutation: boolean,
  ) {
    if (mutation) {
      // One lock shared by ensure/reset/revoke/settings, including the no-link case.
      await tx.$queryRaw`SELECT "id" FROM "Node" WHERE "id" = ${nodeId}::uuid FOR UPDATE`;
    }
    const node = await tx.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: { publicAccess: true },
    });
    if (!node) throw new NotFoundException('Node not found');
    const { capabilities } = await this.authorization.resolveCapabilities(
      actorId,
      nodeId,
      tx,
    );
    if (!capabilities.has(DocumentCapability.VIEW))
      throw new NotFoundException('Node not found');
    const canManageSharing = capabilities.has(DocumentCapability.SHARE);
    if (mutation && !canManageSharing)
      throw new ForbiddenException(
        'You do not have permission to manage sharing',
      );
    return { node, canManageSharing };
  }

  private activeLink(nodeId: string, tx: Prisma.TransactionClient) {
    return tx.shareLink.findFirst({
      where: { nodeId, revokedAt: null },
      select: { id: true },
    });
  }

  private async createLink(
    actorId: string,
    nodeId: string,
    action: 'SHARE_LINK_CREATED' | 'SHARE_LINK_RESET',
    tx: Prisma.TransactionClient,
  ): Promise<ShareLinkResponse> {
    const secret = createShareLinkSecret(this.config.webOrigin);
    const link = await tx.shareLink.create({
      data: { nodeId, createdById: actorId, tokenHash: secret.tokenHash },
      select: { id: true },
    });
    await this.audit(actorId, nodeId, action, { shareLinkId: link.id }, tx);
    // The outer transaction promise must commit before any URL reaches a caller.
    return {
      nodeId,
      shareLink: { id: link.id, created: true, url: secret.url },
    };
  }

  private async audit(
    actorId: string,
    nodeId: string,
    action: SharingAction,
    metadata: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorType: AuditActorType.USER,
        actorId,
        action,
        resourceType: 'NODE',
        resourceId: nodeId,
        result: AuditResult.SUCCESS,
        metadata,
      },
    });
  }

  private async withSerializableRetry<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < SERIALIZATION_RETRIES; attempt += 1) {
      try {
        return await this.database.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (error instanceof HttpException) throw error;
        if (this.isRetryable(error)) {
          if (attempt + 1 < SERIALIZATION_RETRIES) continue;
          throw new ConflictException(
            'Sharing change conflicted with another update',
          );
        }
        // Never expose/log SQL, constraint names, or generated secret material.
        throw new InternalServerErrorException('Sharing operation failed');
      }
    }
    throw new ConflictException(
      'Sharing change conflicted with another update',
    );
  }

  private isRetryable(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false;
    // The existing partial unique index is the final authority for active links.
    if (error.code === 'P2002' || error.code === 'P2034') return true;
    return (
      error.code === 'P2010' &&
      'meta' in error &&
      !!error.meta &&
      typeof error.meta === 'object' &&
      'code' in error.meta &&
      error.meta.code === '40001'
    );
  }
}
