import { ForbiddenException, Injectable } from '@nestjs/common';
import { DocumentRole } from '@dochub/database';
import { DatabaseService } from '../database/database.service.js';
import {
  DOCUMENT_ROLE_CAPABILITIES,
  DocumentCapability,
} from './document-capability.js';

interface NodeChainRow {
  id: string;
  parentId: string | null;
  inheritPermissions: boolean;
  trashOperationId: string | null;
  depth: number;
}

interface UserMembershipRow {
  userId: string;
  groupId: string | null;
}

export interface ResolvedDocumentCapabilities {
  nodeId: string;
  capabilities: ReadonlySet<DocumentCapability>;
}

@Injectable()
export class DocumentAuthorizationService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Resolves explicit user and group permissions on a node and its inheritable
   * ancestors. This deliberately has no creator or system-admin bypass.
   */
  async resolveCapabilities(
    userId: string,
    nodeId: string,
  ): Promise<ResolvedDocumentCapabilities> {
    const nodeChain = await this.database.prisma.$queryRaw<NodeChainRow[]>`
      WITH RECURSIVE node_chain AS (
        SELECT
          "id",
          "parentId",
          "inheritPermissions",
          "trashOperationId",
          0 AS depth,
          ARRAY["id"] AS path
        FROM "Node"
        WHERE "id" = ${nodeId}::uuid

        UNION ALL

        SELECT
          parent."id",
          parent."parentId",
          parent."inheritPermissions",
          parent."trashOperationId",
          child.depth + 1,
          child.path || parent."id"
        FROM "Node" AS parent
        INNER JOIN node_chain AS child ON parent."id" = child."parentId"
        WHERE child."inheritPermissions" = true
          AND NOT parent."id" = ANY(child.path)
      )
      SELECT "id", "parentId", "inheritPermissions", "trashOperationId", depth
      FROM node_chain
    `;

    if (
      nodeChain.length === 0 ||
      nodeChain.some((node) => node.trashOperationId !== null)
    ) {
      return this.emptyResolution(nodeId);
    }

    // Fetching the user and all memberships together lets a missing user fail
    // closed without a per-group query.
    const membershipRows = await this.database.prisma.$queryRaw<
      UserMembershipRow[]
    >`
      SELECT user_record."id" AS "userId", membership."groupId" AS "groupId"
      FROM "User" AS user_record
      LEFT JOIN "GroupMember" AS membership
        ON membership."userId" = user_record."id"
      WHERE user_record."id" = ${userId}::uuid
    `;

    if (membershipRows.length === 0) {
      return this.emptyResolution(nodeId);
    }

    const groupIds = membershipRows.flatMap((membership) =>
      membership.groupId === null ? [] : [membership.groupId],
    );
    const permissionEntries =
      await this.database.prisma.permissionEntry.findMany({
        where: {
          nodeId: { in: nodeChain.map((node) => node.id) },
          OR: [
            { userId },
            ...(groupIds.length > 0 ? [{ groupId: { in: groupIds } }] : []),
          ],
        },
        select: { role: true },
      });

    const capabilities = new Set<DocumentCapability>();
    for (const permissionEntry of permissionEntries) {
      for (const capability of DOCUMENT_ROLE_CAPABILITIES[
        permissionEntry.role as DocumentRole
      ]) {
        capabilities.add(capability);
      }
    }

    return { nodeId, capabilities };
  }

  async hasCapability(
    userId: string,
    nodeId: string,
    capability: DocumentCapability,
  ): Promise<boolean> {
    const resolved = await this.resolveCapabilities(userId, nodeId);
    return resolved.capabilities.has(capability);
  }

  async assertCapability(
    userId: string,
    nodeId: string,
    capability: DocumentCapability,
  ): Promise<void> {
    if (!(await this.hasCapability(userId, nodeId, capability))) {
      throw new ForbiddenException('You do not have access to this document');
    }
  }

  private emptyResolution(nodeId: string): ResolvedDocumentCapabilities {
    return { nodeId, capabilities: new Set<DocumentCapability>() };
  }
}
