import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditActorType,
  AuditResult,
  Prisma,
  UserStatus,
} from '@dochub/database';
import { AUTH_CONFIG, type AuthConfig } from '../auth/auth.config.js';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { UpdateSharingDto } from './dto/update-sharing.dto.js';
import type { SharingState } from './sharing.types.js';

const SERIALIZATION_RETRIES = 3;

@Injectable()
export class SharingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async findPrincipals(actorId: string, query: string) {
    void actorId;
    const [users, groups] = await Promise.all([
      this.database.prisma.user.findMany({
        where: {
          status: UserStatus.ACTIVE,
          OR: [
            { displayName: { contains: query, mode: 'insensitive' } },
            { email: { contains: query, mode: 'insensitive' } },
          ],
        },
        select: { id: true, displayName: true, email: true },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        take: 10,
      }),
      this.database.prisma.group.findMany({
        where: { name: { contains: query, mode: 'insensitive' } },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: 10,
      }),
    ]);
    return {
      items: [
        ...users.map((user) => ({ type: 'USER' as const, ...user })),
        ...groups.map((group) => ({ type: 'GROUP' as const, ...group })),
      ].sort((left, right) => {
        const leftName = left.type === 'USER' ? left.displayName : left.name;
        const rightName = right.type === 'USER' ? right.displayName : right.name;
        return leftName.localeCompare(rightName) || left.id.localeCompare(right.id);
      }),
    };
  }

  async getState(actorId: string, nodeId: string): Promise<SharingState> {
    return this.withSerializableRetry(async (tx) => {
      const { node, canManageSharing } = await this.requireNode(
        actorId,
        nodeId,
        tx,
        false,
      );
      return {
        nodeId,
        generalAccessRole: node.generalAccessRole,
        documentUrl: this.documentUrl(nodeId),
        canManageSharing,
      };
    });
  }

  async updateGeneralAccess(
    actorId: string,
    nodeId: string,
    dto: UpdateSharingDto,
  ) {
    return this.withSerializableRetry(async (tx) => {
      const { node } = await this.requireNode(actorId, nodeId, tx, true);
      if (node.generalAccessRole !== dto.generalAccessRole) {
        await tx.node.update({
          where: { id: nodeId },
          data: { generalAccessRole: dto.generalAccessRole },
        });
        await tx.auditLog.create({
          data: {
            actorType: AuditActorType.USER,
            actorId,
            action: 'GENERAL_ACCESS_CHANGED',
            resourceType: 'NODE',
            resourceId: nodeId,
            result: AuditResult.SUCCESS,
            metadata: {
              previousRole: node.generalAccessRole,
              role: dto.generalAccessRole,
            },
          },
        });
      }
      return {
        nodeId,
        generalAccessRole: dto.generalAccessRole,
        documentUrl: this.documentUrl(nodeId),
      };
    });
  }

  private documentUrl(nodeId: string) {
    const origin = this.config.webOrigins[0] ?? 'http://localhost:5173';
    const url = new URL(`/document/${nodeId}`, origin);
    url.searchParams.set('usp', 'share_link');
    return url.toString();
  }

  private async requireNode(
    actorId: string,
    nodeId: string,
    tx: Prisma.TransactionClient,
    mutation: boolean,
  ) {
    if (mutation)
      await tx.$queryRaw`SELECT "id" FROM "Node" WHERE "id" = ${nodeId}::uuid FOR UPDATE`;
    const node = await tx.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: { generalAccessRole: true },
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
      throw new ForbiddenException('You do not have permission to manage sharing');
    return { node, canManageSharing };
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
          throw new ConflictException('Sharing change conflicted with another update');
        }
        throw new InternalServerErrorException('Sharing operation failed');
      }
    }
    throw new ConflictException('Sharing change conflicted with another update');
  }

  private isRetryable(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error &&
      (error.code === 'P2034' || error.code === '40001');
  }
}
