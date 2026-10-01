import { Injectable, NotFoundException } from '@nestjs/common';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';

const COLLECTION_LIMIT = 50;

export interface CollectionItem {
  id: string;
  parentId: string | null;
  type: 'FILE' | 'FOLDER';
  name: string;
  createdAt: string;
  updatedAt: string;
  capabilities: string[];
  favoritedAt?: string;
  lastAccessedAt?: string;
}

@Injectable()
export class CollectionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
  ) {}

  async listRecent(actorUserId: string) {
    const rows = await this.database.prisma.recentItem.findMany({
      where: { userId: actorUserId },
      orderBy: { lastAccessedAt: 'desc' },
      take: COLLECTION_LIMIT,
      select: { nodeId: true, lastAccessedAt: true },
    });
    const items = await this.visibleItems(actorUserId, rows.map((row) => row.nodeId));
    const itemById = new Map(items.map((item) => [item.id, item]));
    return {
      items: rows.flatMap((row) => {
        const item = itemById.get(row.nodeId);
        return item ? [{ ...item, lastAccessedAt: row.lastAccessedAt.toISOString() }] : [];
      }),
    };
  }

  async listFavorites(actorUserId: string) {
    const rows = await this.database.prisma.favorite.findMany({
      where: { userId: actorUserId },
      orderBy: { createdAt: 'desc' },
      take: COLLECTION_LIMIT,
      select: { nodeId: true, createdAt: true },
    });
    const items = await this.visibleItems(actorUserId, rows.map((row) => row.nodeId));
    const itemById = new Map(items.map((item) => [item.id, item]));
    return {
      items: rows.flatMap((row) => {
        const item = itemById.get(row.nodeId);
        return item ? [{ ...item, favoritedAt: row.createdAt.toISOString() }] : [];
      }),
    };
  }

  async addFavorite(actorUserId: string, nodeId: string) {
    await this.requireVisible(actorUserId, nodeId);
    await this.database.prisma.favorite.upsert({
      where: { userId_nodeId: { userId: actorUserId, nodeId } },
      create: { userId: actorUserId, nodeId },
      update: {},
    });
    return { nodeId, favorited: true };
  }

  async removeFavorite(actorUserId: string, nodeId: string) {
    await this.database.prisma.favorite.deleteMany({
      where: { userId: actorUserId, nodeId },
    });
    return { nodeId, favorited: false };
  }

  async recordRecent(actorUserId: string, nodeId: string) {
    await this.database.prisma.recentItem.upsert({
      where: { userId_nodeId: { userId: actorUserId, nodeId } },
      create: { userId: actorUserId, nodeId },
      update: { lastAccessedAt: new Date() },
    });
  }

  private async visibleItems(actorUserId: string, nodeIds: string[]) {
    const uniqueIds = [...new Set(nodeIds)];
    if (!uniqueIds.length) return [];
    const nodes = await this.database.prisma.node.findMany({
      where: { id: { in: uniqueIds }, trashOperationId: null },
      select: {
        id: true,
        parentId: true,
        type: true,
        name: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const capabilities = await this.authorization.resolveCapabilitiesForNodes(
      actorUserId,
      nodes.map((node) => node.id),
    );
    return nodes.flatMap((node) => {
      const resolved = capabilities.get(node.id)?.capabilities;
      if (!resolved?.has(DocumentCapability.VIEW)) return [];
      return [{
        id: node.id,
        parentId: node.parentId,
        type: node.type,
        name: node.name,
        createdAt: node.createdAt.toISOString(),
        updatedAt: node.updatedAt.toISOString(),
        capabilities: [...resolved],
      } satisfies CollectionItem];
    });
  }

  private async requireVisible(actorUserId: string, nodeId: string) {
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: { id: true },
    });
    const capabilities = node
      ? await this.authorization.resolveCapabilities(actorUserId, node.id)
      : null;
    if (!capabilities?.capabilities.has(DocumentCapability.VIEW))
      throw new NotFoundException('Node not found');
  }
}
