import { createHash } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NodeType } from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

interface NodeChainRow {
  trashOperationId: string | null;
}

export interface ResolvedShareLink {
  node: { id: string; type: NodeType; name: string };
  mode: 'AUTHENTICATED' | 'PUBLIC';
  capabilities: ReadonlySet<DocumentCapability>;
}

@Injectable()
export class ShareResolutionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
  ) {}

  async resolve(
    token: string,
    auth: AuthPrincipal | undefined,
    capability: DocumentCapability,
  ): Promise<ResolvedShareLink> {
    if (!TOKEN_PATTERN.test(token))
      throw new NotFoundException('Share link not found');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const link = await this.database.prisma.shareLink.findFirst({
      where: { tokenHash, revokedAt: null },
      select: {
        node: {
          select: {
            id: true,
            type: true,
            name: true,
            publicAccess: true,
            trashOperationId: true,
          },
        },
      },
    });
    if (!link?.node || link.node.trashOperationId !== null) {
      throw new NotFoundException('Share link not found');
    }
    await this.assertActiveChain(link.node.id);
    if (!auth) {
      if (!link.node.publicAccess)
        throw new NotFoundException('Share link not found');
      if (
        capability !== DocumentCapability.VIEW &&
        capability !== DocumentCapability.PREVIEW
      ) {
        throw new ForbiddenException('Public sharing does not allow downloads');
      }
      return {
        node: link.node,
        mode: 'PUBLIC',
        capabilities: new Set([
          DocumentCapability.VIEW,
          DocumentCapability.PREVIEW,
        ]),
      };
    }
    const resolved = await this.authorization.resolveCapabilities(
      auth.userId,
      link.node.id,
    );
    if (
      !resolved.capabilities.has(DocumentCapability.VIEW) ||
      !resolved.capabilities.has(capability)
    ) {
      throw new NotFoundException('Share link not found');
    }
    return {
      node: link.node,
      mode: 'AUTHENTICATED',
      capabilities: resolved.capabilities,
    };
  }

  private async assertActiveChain(nodeId: string): Promise<void> {
    const chain = await this.database.prisma.$queryRaw<NodeChainRow[]>`
      WITH RECURSIVE node_chain AS (
        SELECT "id", "parentId", "inheritPermissions", "trashOperationId", ARRAY["id"] AS path
        FROM "Node" WHERE "id" = ${nodeId}::uuid
        UNION ALL
        SELECT parent."id", parent."parentId", parent."inheritPermissions", parent."trashOperationId", child.path || parent."id"
        FROM "Node" AS parent
        INNER JOIN node_chain AS child ON parent."id" = child."parentId"
        WHERE child."inheritPermissions" = true AND NOT parent."id" = ANY(child.path)
      ) SELECT "trashOperationId" FROM node_chain
    `;
    if (
      chain.length === 0 ||
      chain.some((node) => node.trashOperationId !== null)
    ) {
      throw new NotFoundException('Share link not found');
    }
  }
}
