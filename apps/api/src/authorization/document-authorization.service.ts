import { ForbiddenException, Injectable } from '@nestjs/common';
import { DocumentRole, Prisma, type PrismaClient } from '@dochub/database';
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

export type DocumentAuthorizationClient =
  PrismaClient | Prisma.TransactionClient;

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
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<ResolvedDocumentCapabilities> {
    return this.resolveCapabilitiesInternal(userId, nodeId, client, false);
  }

  /** Resolves normal capabilities for a bounded set without scalar per-node lookups. */
  async resolveCapabilitiesForNodes(
    userId: string,
    nodeIds: readonly string[],
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<Map<string, ResolvedDocumentCapabilities>> {
    const results = new Map<string, ResolvedDocumentCapabilities>();
    const uniqueIds = [...new Set(nodeIds)];
    if (uniqueIds.length === 0) return results;
    const nodeChain = await client.$queryRaw<
      (NodeChainRow & { targetId: string })[]
    >`
      WITH RECURSIVE node_chain AS (
        SELECT "id" AS "targetId", "id", "parentId", "inheritPermissions", "trashOperationId", 0 AS depth, ARRAY["id"] AS path
        FROM "Node" WHERE "id" IN (${Prisma.join(uniqueIds.map((id) => Prisma.sql`${id}::uuid`))})
        UNION ALL
        SELECT child."targetId", parent."id", parent."parentId", parent."inheritPermissions", parent."trashOperationId", child.depth + 1, child.path || parent."id"
        FROM "Node" AS parent INNER JOIN node_chain AS child ON parent."id" = child."parentId"
        WHERE child."inheritPermissions" = true AND NOT parent."id" = ANY(child.path)
      ) SELECT "targetId", "id", "parentId", "inheritPermissions", "trashOperationId", depth FROM node_chain
    `;
    const chains = new Map<string, (NodeChainRow & { targetId: string })[]>();
    for (const row of nodeChain)
      chains.set(row.targetId, [...(chains.get(row.targetId) ?? []), row]);
    const groupIds = await this.findUserGroupIds(userId, client);
    if (groupIds === null) {
      for (const nodeId of uniqueIds)
        results.set(nodeId, this.emptyResolution(nodeId));
      return results;
    }
    const explicit = await this.resolveExplicitCapabilities(
      userId,
      [...new Set(nodeChain.map((row) => row.id))],
      groupIds,
      client,
    );
    for (const nodeId of uniqueIds) {
      const chain = chains.get(nodeId) ?? [];
      if (
        chain.length === 0 ||
        chain.some((node) => node.trashOperationId !== null)
      )
        results.set(nodeId, this.emptyResolution(nodeId));
      else {
        const capabilities = new Set<DocumentCapability>();
        for (const node of chain)
          for (const capability of explicit.get(node.id) ?? [])
            capabilities.add(capability);
        results.set(nodeId, { nodeId, capabilities });
      }
    }
    return results;
  }

  /** Lifecycle-only ACL lookup; normal document reads must continue hiding Trash. */
  async resolveTrashCapabilities(
    userId: string,
    nodeId: string,
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<ResolvedDocumentCapabilities> {
    return this.resolveCapabilitiesInternal(userId, nodeId, client, true);
  }

  private async resolveCapabilitiesInternal(
    userId: string,
    nodeId: string,
    client: DocumentAuthorizationClient,
    includeTrashed: boolean,
  ): Promise<ResolvedDocumentCapabilities> {
    const nodeChain = await client.$queryRaw<NodeChainRow[]>`
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
      (!includeTrashed &&
        nodeChain.some((node) => node.trashOperationId !== null))
    ) {
      return this.emptyResolution(nodeId);
    }

    // Fetching the user and all memberships together lets a missing user fail
    // closed without a per-group query.
    const groupIds = await this.findUserGroupIds(userId, client);
    if (groupIds === null) {
      return this.emptyResolution(nodeId);
    }

    const capabilitiesByNode = await this.resolveExplicitCapabilities(
      userId,
      nodeChain.map((node) => node.id),
      groupIds,
      client,
    );
    const capabilities = new Set<DocumentCapability>();
    for (const node of nodeChain) {
      for (const capability of capabilitiesByNode.get(node.id) ?? []) {
        capabilities.add(capability);
      }
    }
    return { nodeId, capabilities };
  }

  /** Returns null if the principal no longer exists. */
  async findUserGroupIds(
    userId: string,
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<string[] | null> {
    const membershipRows = await client.$queryRaw<UserMembershipRow[]>`
      SELECT user_record."id" AS "userId", membership."groupId" AS "groupId"
      FROM "User" AS user_record
      LEFT JOIN "GroupMember" AS membership
        ON membership."userId" = user_record."id"
      WHERE user_record."id" = ${userId}::uuid
    `;
    if (membershipRows.length === 0) {
      return null;
    }
    return [
      ...new Set(
        membershipRows.flatMap((membership) =>
          membership.groupId === null ? [] : [membership.groupId],
        ),
      ),
    ];
  }

  /**
   * Resolves only direct ACL entries for a bounded set of nodes. Callers that
   * need inheritance compose these results using their known hierarchy.
   */
  async resolveExplicitCapabilities(
    userId: string,
    nodeIds: readonly string[],
    groupIds: readonly string[],
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<Map<string, ReadonlySet<DocumentCapability>>> {
    const capabilitiesByNode = new Map<
      string,
      ReadonlySet<DocumentCapability>
    >();
    if (nodeIds.length === 0) {
      return capabilitiesByNode;
    }

    const permissionEntries = await client.permissionEntry.findMany({
      where: {
        nodeId: { in: [...nodeIds] },
        OR: [
          { userId },
          ...(groupIds.length > 0 ? [{ groupId: { in: [...groupIds] } }] : []),
        ],
      },
      select: { nodeId: true, role: true },
    });
    for (const permissionEntry of permissionEntries) {
      const capabilities = new Set(
        capabilitiesByNode.get(permissionEntry.nodeId) ?? [],
      );
      for (const capability of DOCUMENT_ROLE_CAPABILITIES[
        permissionEntry.role as DocumentRole
      ]) {
        capabilities.add(capability);
      }
      capabilitiesByNode.set(permissionEntry.nodeId, capabilities);
    }
    return capabilitiesByNode;
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
