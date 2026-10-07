import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  GeneralAccessRole,
  NodeType,
  Prisma,
  UserStatus,
} from '@dochub/database';
import { DatabaseService } from '../database/database.service.js';
import {
  DocumentAuthorizationService,
  type DocumentAuthorizationClient,
} from './document-authorization.service.js';
import { DocumentCapability } from './document-capability.js';
import { canManageDocuments, canViewDocuments } from '../common/system-role-policy.js';

export type FolderReference =
  | { kind: 'ROOT'; parentId: null }
  | { kind: 'NODE'; nodeId: string; parentId: string | null };

export interface ResolvedFolder {
  reference: FolderReference;
  node: { id: string; parentId: string | null; type: NodeType } | null;
  capabilities: ReadonlySet<DocumentCapability>;
}

/**
 * The folder boundary used by all container operations. ROOT is deliberately
 * not a Node row; it is the domain-level folder at parentId IS NULL.
 */
@Injectable()
export class FolderAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
  ) {}

  async resolve(
    actorUserId: string,
    parentId: string | null,
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<ResolvedFolder> {
    if (parentId === null) {
      const user = await client.user.findUnique({
        where: { id: actorUserId },
        select: { status: true, systemRole: true },
      });
      const systemRole = user?.systemRole;
      const view =
        user?.status === UserStatus.ACTIVE &&
        systemRole !== undefined &&
        canViewDocuments(systemRole);
      const manage =
        user?.status === UserStatus.ACTIVE &&
        systemRole !== undefined &&
        canManageDocuments(systemRole);
      return {
        reference: { kind: 'ROOT', parentId: null },
        node: null,
        capabilities:
          view
            ? new Set([
                DocumentCapability.VIEW,
                ...(manage
                  ? [DocumentCapability.CREATE]
                  : []),
              ])
            : new Set(),
      };
    }

    const node = await client.node.findFirst({
      where: { id: parentId, trashOperationId: null },
      select: { id: true, parentId: true, type: true },
    });
    if (!node) {
      throw new NotFoundException('Node not found');
    }
    const resolved = await this.authorization.resolveCapabilities(
      actorUserId,
      node.id,
      client,
    );
    return {
      reference: { kind: 'NODE', nodeId: node.id, parentId: node.parentId },
      node,
      capabilities: resolved.capabilities,
    };
  }

  async requireBrowse(
    actorUserId: string,
    parentId: string | null,
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<ResolvedFolder> {
    const folder = await this.resolve(actorUserId, parentId, client);
    this.requireFolder(folder);
    if (!folder.capabilities.has(DocumentCapability.VIEW)) {
      throw new NotFoundException('Node not found');
    }
    return folder;
  }

  async requireCreate(
    actorUserId: string,
    parentId: string | null,
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<ResolvedFolder> {
    const folder = await this.resolve(actorUserId, parentId, client);
    this.requireFolder(folder);
    if (
      folder.reference.kind !== 'ROOT' &&
      !folder.capabilities.has(DocumentCapability.VIEW)
    ) {
      throw new NotFoundException('Node not found');
    }
    if (!folder.capabilities.has(DocumentCapability.CREATE)) {
      throw new ForbiddenException(
        folder.reference.kind === 'ROOT'
          ? 'Document-management access is required for root placement'
          : 'You do not have the required document capability',
      );
    }
    return folder;
  }

  /**
   * Returns the database-level visibility predicate for children of a folder.
   * Root has no parent capability to inherit, so its children must have their
   * own effective VIEW through general access or an ACL.
   */
  childVisibilityWhere(
    folder: ResolvedFolder,
    userId: string,
    groupIds: readonly string[],
  ): Prisma.NodeWhereInput {
    const principals: Prisma.PermissionEntryWhereInput[] = [
      { userId },
      ...(groupIds.length > 0 ? [{ groupId: { in: [...groupIds] } }] : []),
    ];
    const directVisibility: Prisma.NodeWhereInput[] = [
      {
        generalAccessRole: {
          in: [GeneralAccessRole.VIEWER, GeneralAccessRole.EDITOR],
        },
      },
      { permissionEntries: { some: { OR: principals } } },
    ];

    if (folder.reference.kind === 'ROOT') {
      return {
        parentId: null,
        trashOperationId: null,
        OR: directVisibility,
      };
    }

    return {
      parentId: folder.reference.nodeId,
      trashOperationId: null,
      OR: [{ inheritPermissions: true }, ...directVisibility],
    };
  }

  private requireFolder(folder: ResolvedFolder): void {
    if (folder.node && folder.node.type !== NodeType.FOLDER) {
      throw new ConflictException('A file cannot be used as a parent folder');
    }
  }
}
