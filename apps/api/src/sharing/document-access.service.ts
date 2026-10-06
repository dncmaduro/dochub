import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuditActorType,
  AuditResult,
  GeneralAccessRole,
  NodeType,
} from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { DatabaseService } from '../database/database.service.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface NodeChainRow {
  trashOperationId: string | null;
}

export interface ResolvedDocumentAccess {
  node: { id: string; type: NodeType; name: string; mimeType: string | null };
  generalAccessRole: GeneralAccessRole;
  mode: 'AUTHENTICATED' | 'PUBLIC';
  capabilities: ReadonlySet<DocumentCapability>;
}

@Injectable()
export class DocumentAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
  ) {}

  async resolve(
    nodeId: string,
    auth: AuthPrincipal | undefined,
    capability: DocumentCapability,
  ): Promise<ResolvedDocumentAccess> {
    if (!UUID_PATTERN.test(nodeId)) throw new NotFoundException('Document not found');
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: {
        id: true,
        type: true,
        name: true,
        generalAccessRole: true,
        file: { select: { currentVersion: { select: { mimeType: true } } } },
      },
    });
    if (!node) throw new NotFoundException('Document not found');
    await this.assertActiveChain(node.id);

    const capabilities = this.generalAccessCapabilities(node.generalAccessRole);
    if (auth) {
      const acl = await this.authorization.resolveCapabilities(auth.userId, node.id);
      for (const granted of acl.capabilities) capabilities.add(granted);
    }

    const allowed = capabilities.has(DocumentCapability.VIEW) && capabilities.has(capability);
    await this.audit(node.id, auth, capability, allowed);
    if (!capabilities.has(DocumentCapability.VIEW)) {
      if (!auth && node.generalAccessRole === GeneralAccessRole.RESTRICTED)
        throw new UnauthorizedException('Sign in to access this document');
      throw new ForbiddenException('You do not have access to this document');
    }
    if (!capabilities.has(capability))
      throw new ForbiddenException('You do not have permission to access this document');

    return {
      node: {
        id: node.id,
        type: node.type,
        name: node.name,
        mimeType: node.file?.currentVersion?.mimeType ?? null,
      },
      generalAccessRole: node.generalAccessRole,
      mode: auth ? 'AUTHENTICATED' : 'PUBLIC',
      capabilities,
    };
  }

  private generalAccessCapabilities(role: GeneralAccessRole) {
    const capabilities = new Set<DocumentCapability>();
    if (role !== GeneralAccessRole.RESTRICTED) {
      capabilities.add(DocumentCapability.VIEW);
      capabilities.add(DocumentCapability.PREVIEW);
    }
    if (role === GeneralAccessRole.EDITOR)
      capabilities.add(DocumentCapability.EDIT);
    return capabilities;
  }

  private audit(
    nodeId: string,
    auth: AuthPrincipal | undefined,
    requestedCapability: DocumentCapability,
    allowed: boolean,
  ) {
    return this.database.prisma.auditLog.create({
      data: {
        actorType: auth ? AuditActorType.USER : AuditActorType.PUBLIC,
        actorId: auth?.userId,
        action: 'DOCUMENT_ACCESS',
        resourceType: 'NODE',
        resourceId: nodeId,
        result: allowed ? AuditResult.SUCCESS : AuditResult.DENIED,
        metadata: { requestedCapability },
      },
    });
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
    if (chain.length === 0 || chain.some((row) => row.trashOperationId !== null))
      throw new NotFoundException('Document not found');
  }
}
