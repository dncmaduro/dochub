import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditActorType,
  AuditResult,
  FileVersionActorType,
  FileProcessingTaskType,
  NodeType,
  Prisma,
  SystemRole,
  UserStatus,
} from '@dochub/database';
import {
  DocumentAuthorizationService,
  type DocumentAuthorizationClient,
} from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { FolderAccessService } from '../authorization/folder-access.service.js';
import { DatabaseService } from '../database/database.service.js';
import { CollectionsService } from '../collections/collections.service.js';
import { contentSearchStatus } from '../common/file-processing-state.js';
import { actorResponse } from '../common/file-attribution.js';
import {
  CreateFolderDto,
  MoveNodeDto,
  NodeListQueryDto,
  RenameNodeDto,
} from './dto/node.dto.js';
import { decodeNodeCursor, encodeNodeCursor } from './node-cursor.js';
import { normalizeNodeName } from './node-name.js';
import {
  DEFAULT_NODE_SORT_BY,
  DEFAULT_NODE_SORT_DIRECTION,
  NodeSortBy,
  NodeSortDirection,
} from './node-sort.js';
import type {
  BreadcrumbResponse,
  NodePage,
  NodeResponse,
} from './node.types.js';

const DEFAULT_PAGE_LIMIT = 50;
const SERIALIZATION_RETRIES = 3;

const nodeSelect = {
  id: true,
  parentId: true,
  type: true,
  name: true,
  normalizedName: true,
  inheritPermissions: true,
  createdAt: true,
  updatedAt: true,
  updatedBy: { select: { id: true, displayName: true } },
  file: {
    select: {
      currentVersion: {
        select: {
          createdAt: true,
          actorType: true,
          createdBy: { select: { id: true, displayName: true } },
          mimeType: true,
          processingTasks: {
            where: { type: FileProcessingTaskType.TEXT_EXTRACTION },
            select: { status: true },
          },
        },
      },
    },
  },
} satisfies Prisma.NodeSelect;

type SelectedNode = Prisma.NodeGetPayload<{ select: typeof nodeSelect }>;

interface OrderedNodeIdRow {
  id: string;
}

interface BreadcrumbNodeRow {
  id: string;
  parentId: string | null;
  type: NodeType;
  name: string;
  inheritPermissions: boolean;
  trashOperationId: string | null;
  depth: number;
}

@Injectable()
export class NodesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    private readonly collections?: CollectionsService,
    private readonly folders: FolderAccessService = new FolderAccessService(
      database,
      authorization,
    ),
  ) {}

  async createFolder(
    actorUserId: string,
    dto: CreateFolderDto,
  ): Promise<NodeResponse> {
    const name = normalizeNodeName(dto.name);
    const parentId = dto.parentId ?? null;
    try {
      return await this.database.prisma.$transaction(async (transaction) => {
        await this.folders.requireCreate(actorUserId, parentId, transaction);

        const node = await transaction.node.create({
          data: {
            parentId,
            type: NodeType.FOLDER,
            name: name.name,
            normalizedName: name.normalizedName,
            createdById: actorUserId,
            updatedById: actorUserId,
          },
          select: nodeSelect,
        });
        await transaction.permissionEntry.create({
          data: {
            nodeId: node.id,
            userId: actorUserId,
            role: 'OWNER',
          },
        });
        await this.writeAudit(transaction, {
          actorUserId,
          action: 'FOLDER_CREATED',
          resourceId: node.id,
          metadata: { parentId },
        });
        return this.nodeResponse(
          node,
          new Set(Object.values(DocumentCapability)),
        );
      });
    } catch (error) {
      this.throwNameConflict(error);
      throw error;
    }
  }

  async getNode(actorUserId: string, nodeId: string): Promise<NodeResponse> {
    const visible = await this.requireVisibleNode(actorUserId, nodeId);
    return this.nodeResponse(visible.node, visible.capabilities);
  }

  async listRoot(
    actorUserId: string,
    query: NodeListQueryDto,
  ): Promise<NodePage> {
    const root = await this.folders.requireBrowse(actorUserId, null);
    return this.listFolder(actorUserId, root, query);
  }

  async listChildren(
    actorUserId: string,
    parentId: string,
    query: NodeListQueryDto,
  ): Promise<NodePage> {
    const parent = await this.folders.requireBrowse(actorUserId, parentId);
    void this.collections
      ?.recordRecent(actorUserId, parentId)
      .catch(() => undefined);
    return this.listFolder(actorUserId, parent, query);
  }

  private async listFolder(
    actorUserId: string,
    folder: Awaited<ReturnType<FolderAccessService['requireBrowse']>>,
    query: NodeListQueryDto,
  ): Promise<NodePage> {
    const groupIds = await this.authorization.findUserGroupIds(actorUserId);
    if (groupIds === null) {
      throw new NotFoundException('Node not found');
    }
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const sortBy = query.sortBy ?? DEFAULT_NODE_SORT_BY;
    const sortDirection =
      query.sortDirection ??
      (sortBy === NodeSortBy.LAST_MODIFIED
        ? NodeSortDirection.DESC
        : DEFAULT_NODE_SORT_DIRECTION);
    const cursor = decodeNodeCursor(
      query.cursor,
      sortBy,
      sortDirection,
    );
    const orderedIds = await this.findOrderedNodeIds(
      actorUserId,
      folder,
      groupIds,
      limit,
      sortBy,
      sortDirection,
      cursor,
    );
    const selectedNodes =
      orderedIds.length === 0
        ? []
        : await this.database.prisma.node.findMany({
            where: { id: { in: orderedIds } },
            select: nodeSelect,
          });
    const nodesById = new Map(selectedNodes.map((node) => [node.id, node]));
    const nodes = orderedIds.flatMap((id) => {
      const node = nodesById.get(id);
      return node ? [node] : [];
    });
    const capabilitiesByNode =
      await this.authorization.resolveCapabilitiesForNodes(
        actorUserId,
        nodes.map((node) => node.id),
      );
    return this.nodePage(
      nodes,
      limit,
      new Map(
        [...capabilitiesByNode].map(([id, resolution]) => [
          id,
          resolution.capabilities,
        ]),
      ),
      sortBy,
      sortDirection,
    );
  }

  private async findOrderedNodeIds(
    actorUserId: string,
    folder: Awaited<ReturnType<FolderAccessService['requireBrowse']>>,
    groupIds: readonly string[],
    limit: number,
    sortBy: NodeSortBy,
    sortDirection: NodeSortDirection,
    cursor: ReturnType<typeof decodeNodeCursor>,
  ): Promise<string[]> {
    const visibility = this.childVisibilitySql(folder, actorUserId, groupIds);
    const cursorPredicate = this.cursorPredicateSql(
      cursor,
      sortBy,
      sortDirection,
    );
    const direction =
      sortDirection === NodeSortDirection.ASC
        ? Prisma.sql`ASC`
        : Prisma.sql`DESC`;

    if (sortBy === NodeSortBy.NAME) {
      const rows = await this.database.prisma.$queryRaw<OrderedNodeIdRow[]>`
        SELECT n."id"
        FROM "Node" AS n
        WHERE ${visibility}
          ${cursorPredicate}
        ORDER BY n."normalizedName" ${direction}, n."id" ASC
        LIMIT ${limit + 1}
      `;
      return rows.map((row) => row.id);
    }

    const rows = await this.database.prisma.$queryRaw<OrderedNodeIdRow[]>`
      SELECT n."id"
      FROM "Node" AS n
      LEFT JOIN "File" AS file_record ON file_record."nodeId" = n."id"
      LEFT JOIN "FileVersion" AS current_version
        ON current_version."id" = file_record."currentVersionId"
      WHERE ${visibility}
        ${cursorPredicate}
      ORDER BY
        COALESCE(current_version."createdAt", n."updatedAt") ${direction},
        n."id" ASC
      LIMIT ${limit + 1}
    `;
    return rows.map((row) => row.id);
  }

  private childVisibilitySql(
    folder: Awaited<ReturnType<FolderAccessService['requireBrowse']>>,
    actorUserId: string,
    groupIds: readonly string[],
  ): Prisma.Sql {
    const groupVisibility =
      groupIds.length > 0
        ? Prisma.sql`OR permission_entry."groupId" IN (${Prisma.join(
            groupIds.map((groupId) => Prisma.sql`${groupId}::uuid`),
          )})`
        : Prisma.empty;
    const directVisibility = Prisma.sql`
      (
        n."generalAccessRole" IN ('VIEWER', 'EDITOR')
        OR EXISTS (
          SELECT 1
          FROM "PermissionEntry" AS permission_entry
          WHERE permission_entry."nodeId" = n."id"
            AND (
              permission_entry."userId" = ${actorUserId}::uuid
              ${groupVisibility}
            )
        )
      )
    `;
    const parentPredicate =
      folder.reference.kind === 'ROOT'
        ? Prisma.sql`n."parentId" IS NULL`
        : Prisma.sql`n."parentId" = ${folder.reference.nodeId}::uuid`;
    const visibility =
      folder.reference.kind === 'ROOT'
        ? directVisibility
        : Prisma.sql`(n."inheritPermissions" = TRUE OR ${directVisibility})`;
    return Prisma.sql`
      ${parentPredicate}
      AND n."trashOperationId" IS NULL
      AND ${visibility}
    `;
  }

  private cursorPredicateSql(
    cursor: ReturnType<typeof decodeNodeCursor>,
    sortBy: NodeSortBy,
    sortDirection: NodeSortDirection,
  ): Prisma.Sql {
    if (!cursor) return Prisma.empty;
    const comparison =
      sortDirection === NodeSortDirection.ASC
        ? Prisma.sql`>`
        : Prisma.sql`<`;
    if (sortBy === NodeSortBy.NAME) {
      return Prisma.sql`
        AND (
          n."normalizedName" ${comparison} ${cursor.sortValue}
          OR (
            n."normalizedName" = ${cursor.sortValue}
            AND n."id" > ${cursor.id}::uuid
          )
        )
      `;
    }
    const modifiedAt = Prisma.sql`
      COALESCE(current_version."createdAt", n."updatedAt")
    `;
    const cursorDate = new Date(cursor.sortValue);
    return Prisma.sql`
      AND (
        ${modifiedAt} ${comparison} ${cursorDate}
        OR (
          ${modifiedAt} = ${cursorDate}
          AND n."id" > ${cursor.id}::uuid
        )
      )
    `;
  }

  async breadcrumb(
    actorUserId: string,
    nodeId: string,
  ): Promise<BreadcrumbResponse> {
    await this.requireVisibleNode(actorUserId, nodeId);
    const chain = await this.database.prisma.$queryRaw<BreadcrumbNodeRow[]>`
      WITH RECURSIVE node_chain AS (
        SELECT
          "id", "parentId", "type", "name", "inheritPermissions",
          "trashOperationId", 0 AS depth, ARRAY["id"] AS path
        FROM "Node"
        WHERE "id" = ${nodeId}::uuid

        UNION ALL

        SELECT
          parent."id", parent."parentId", parent."type", parent."name",
          parent."inheritPermissions", parent."trashOperationId",
          child.depth + 1, child.path || parent."id"
        FROM "Node" AS parent
        INNER JOIN node_chain AS child ON parent."id" = child."parentId"
        WHERE NOT parent."id" = ANY(child.path)
      )
      SELECT "id", "parentId", "type", "name", "inheritPermissions", "trashOperationId", depth
      FROM node_chain
    `;
    if (
      chain.length === 0 ||
      chain.some((node) => node.trashOperationId !== null)
    ) {
      throw new NotFoundException('Node not found');
    }
    const groupIds = await this.authorization.findUserGroupIds(actorUserId);
    if (groupIds === null) {
      throw new NotFoundException('Node not found');
    }
    const explicit = await this.authorization.resolveExplicitCapabilities(
      actorUserId,
      chain.map((node) => node.id),
      groupIds,
    );
    const rootToTarget = [...chain].reverse();
    const capabilitiesByNode = new Map<
      string,
      ReadonlySet<DocumentCapability>
    >();
    for (const node of rootToTarget) {
      const parentCapabilities = node.parentId
        ? (capabilitiesByNode.get(node.parentId) ??
          new Set<DocumentCapability>())
        : new Set<DocumentCapability>();
      const capabilities = new Set<DocumentCapability>(
        node.parentId !== null && node.inheritPermissions
          ? parentCapabilities
          : [],
      );
      for (const capability of explicit.get(node.id) ?? []) {
        capabilities.add(capability);
      }
      capabilitiesByNode.set(node.id, capabilities);
    }
    let suffixStart = rootToTarget.length - 1;
    while (
      suffixStart > 0 &&
      capabilitiesByNode
        .get(rootToTarget[suffixStart - 1].id)
        ?.has(DocumentCapability.VIEW)
    ) {
      suffixStart -= 1;
    }
    return {
      items: rootToTarget.slice(suffixStart).map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
      })),
      truncated: suffixStart > 0,
    };
  }

  async renameNode(
    actorUserId: string,
    nodeId: string,
    dto: RenameNodeDto,
  ): Promise<NodeResponse> {
    const name = normalizeNodeName(dto.name);
    try {
      return await this.database.prisma.$transaction(async (transaction) => {
        const visible = await this.requireVisibleNode(
          actorUserId,
          nodeId,
          transaction,
        );
        this.requireCapability(visible.capabilities, DocumentCapability.RENAME);
        if (visible.node.name === name.name) {
          return this.nodeResponse(visible.node, visible.capabilities);
        }
        const updated = await transaction.node.update({
          where: { id: nodeId },
          data: {
            name: name.name,
            normalizedName: name.normalizedName,
            updatedById: actorUserId,
          },
          select: nodeSelect,
        });
        await this.writeAudit(transaction, {
          actorUserId,
          action: 'NODE_RENAMED',
          resourceId: nodeId,
          metadata: {
            before: { name: visible.node.name },
            after: { name: name.name },
          },
        });
        return this.nodeResponse(updated, visible.capabilities);
      });
    } catch (error) {
      this.throwNameConflict(error);
      throw error;
    }
  }

  async moveNode(
    actorUserId: string,
    nodeId: string,
    dto: MoveNodeDto,
  ): Promise<NodeResponse> {
    const targetParentId = dto.parentId ?? null;
    for (let attempt = 0; attempt < SERIALIZATION_RETRIES; attempt += 1) {
      try {
        return await this.database.prisma.$transaction(
          async (transaction) => {
            const source = await this.requireVisibleNode(
              actorUserId,
              nodeId,
              transaction,
            );
            this.requireCapability(
              source.capabilities,
              DocumentCapability.MOVE,
            );

            if (targetParentId === null) {
              await this.requireRootAdministrator(actorUserId, transaction);
            } else {
              const destination = await this.requireVisibleNode(
                actorUserId,
                targetParentId,
                transaction,
              );
              this.requireFolder(destination.node);
              this.requireCapability(
                destination.capabilities,
                DocumentCapability.CREATE,
              );
              await this.assertNotDescendant(
                nodeId,
                targetParentId,
                transaction,
              );
            }

            if (source.node.parentId === targetParentId) {
              return this.nodeResponse(source.node, source.capabilities);
            }
            const updated = await transaction.node.update({
              where: { id: nodeId },
              data: { parentId: targetParentId, updatedById: actorUserId },
              select: nodeSelect,
            });
            await this.writeAudit(transaction, {
              actorUserId,
              action: 'NODE_MOVED',
              resourceId: nodeId,
              metadata: {
                fromParentId: source.node.parentId,
                toParentId: targetParentId,
              },
            });
            const effective = await this.authorization.resolveCapabilities(
              actorUserId,
              nodeId,
              transaction,
            );
            return this.nodeResponse(updated, effective.capabilities);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          throw new ConflictException('A node with this name already exists');
        }
        if (this.isSerializationConflict(error)) {
          if (attempt + 1 < SERIALIZATION_RETRIES) {
            continue;
          }
          throw new ConflictException(
            'Move conflicted with another hierarchy change',
          );
        }
        throw error;
      }
    }
    throw new ConflictException(
      'Move conflicted with another hierarchy change',
    );
  }

  private async requireVisibleNode(
    actorUserId: string,
    nodeId: string,
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<{
    node: SelectedNode;
    capabilities: ReadonlySet<DocumentCapability>;
  }> {
    const node = await client.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: nodeSelect,
    });
    if (!node) {
      throw new NotFoundException('Node not found');
    }
    const resolved = await this.authorization.resolveCapabilities(
      actorUserId,
      nodeId,
      client,
    );
    if (!resolved.capabilities.has(DocumentCapability.VIEW)) {
      throw new NotFoundException('Node not found');
    }
    return { node, capabilities: resolved.capabilities };
  }

  private async requireRootAdministrator(
    actorUserId: string,
    client: DocumentAuthorizationClient,
  ): Promise<void> {
    const user = await client.user.findUnique({
      where: { id: actorUserId },
      select: { status: true, systemRole: true },
    });
    if (
      user?.status !== UserStatus.ACTIVE ||
      user.systemRole !== SystemRole.ADMIN
    ) {
      throw new ForbiddenException(
        'Root placement requires an active administrator',
      );
    }
  }

  private requireFolder(node: SelectedNode): void {
    if (node.type !== NodeType.FOLDER) {
      throw new ConflictException('A file cannot be used as a parent folder');
    }
  }

  private requireCapability(
    capabilities: ReadonlySet<DocumentCapability>,
    capability: DocumentCapability,
  ): void {
    if (!capabilities.has(capability)) {
      throw new ForbiddenException(
        'You do not have the required document capability',
      );
    }
  }

  private async assertNotDescendant(
    sourceId: string,
    destinationId: string,
    client: DocumentAuthorizationClient,
  ): Promise<void> {
    const descendants = await client.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE descendants AS (
        SELECT "id", "parentId", ARRAY["id"] AS path
        FROM "Node"
        WHERE "id" = ${sourceId}::uuid

        UNION ALL

        SELECT child."id", child."parentId", parent.path || child."id"
        FROM "Node" AS child
        INNER JOIN descendants AS parent ON child."parentId" = parent."id"
        WHERE NOT child."id" = ANY(parent.path)
      )
      SELECT "id" FROM descendants WHERE "id" = ${destinationId}::uuid LIMIT 1
    `;
    if (descendants.length > 0) {
      throw new ConflictException(
        'A node cannot be moved into itself or its descendant',
      );
    }
  }

  private nodePage(
    records: SelectedNode[],
    limit: number,
    capabilitiesByNode: ReadonlyMap<string, ReadonlySet<DocumentCapability>>,
    sortBy: NodeSortBy,
    sortDirection: NodeSortDirection,
  ): NodePage {
    const page = records.slice(0, limit);
    const finalNode = page.at(-1);
    const items = page.map((node) =>
      this.nodeResponse(node, capabilitiesByNode.get(node.id) ?? new Set()),
    );
    const finalItem = items.at(-1);
    return {
      items,
      nextCursor:
        records.length > limit && finalNode && finalItem
          ? encodeNodeCursor({
              sortBy,
              sortDirection,
              sortValue:
                sortBy === NodeSortBy.NAME
                  ? finalNode.normalizedName
                  : finalItem.lastModified.at.toISOString(),
              id: finalNode.id,
            })
          : null,
    };
  }

  private nodeResponse(
    node: SelectedNode,
    capabilities: ReadonlySet<DocumentCapability>,
  ): NodeResponse {
    return {
      id: node.id,
      parentId: node.parentId,
      type: node.type,
      name: node.name,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      lastModified: node.file?.currentVersion
        ? {
            at: node.file.currentVersion.createdAt,
            actor: actorResponse(
              node.file.currentVersion.actorType,
              node.file.currentVersion.createdBy,
            ),
          }
        : {
            at: node.updatedAt,
            actor: actorResponse(FileVersionActorType.USER, node.updatedBy),
          },
      capabilities: Object.values(DocumentCapability).filter((capability) =>
        capabilities.has(capability),
      ),
      processing: (() => {
        const contentSearch = contentSearchStatus(node.file?.currentVersion);
        return contentSearch ? { contentSearch } : null;
      })(),
    };
  }

  private async writeAudit(
    transaction: Prisma.TransactionClient,
    input: {
      actorUserId: string;
      action: 'FOLDER_CREATED' | 'NODE_RENAMED' | 'NODE_MOVED';
      resourceId: string;
      metadata: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        actorType: AuditActorType.USER,
        actorId: input.actorUserId,
        action: input.action,
        resourceType: 'NODE',
        resourceId: input.resourceId,
        result: AuditResult.SUCCESS,
        metadata: input.metadata,
      },
    });
  }

  private throwNameConflict(error: unknown): void {
    if (this.isUniqueViolation(error)) {
      throw new ConflictException('A node with this name already exists');
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

  private isSerializationConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) {
      return false;
    }
    if (error.code === 'P2034') {
      return true;
    }
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
