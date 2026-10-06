import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentRole, GeneralAccessRole, NodeType, prisma, UserStatus } from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { DocumentAccessService } from './document-access.service.js';

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeWithDatabase('DocumentAccessService integration', () => {
  const suffix = randomUUID();
  const ownerId = randomUUID();
  const editorId = randomUUID();
  const noAclId = randomUUID();
  const nodeIds: string[] = [];
  const database = { prisma } as unknown as DatabaseService;
  const access = new DocumentAccessService(database, new DocumentAuthorizationService(database));
  let nodeId: string;

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [ownerId, editorId, noAclId].map((id, index) => ({
        id,
        email: `document-access-${index}-${suffix}@example.test`,
        normalizedEmail: `document-access-${index}-${suffix}@example.test`,
        displayName: `Document Access ${index}`,
        status: UserStatus.ACTIVE,
      })),
    });
    const node = await prisma.node.create({
      data: {
        type: NodeType.FOLDER,
        name: `document-access-${suffix}`,
        normalizedName: `document-access-${suffix}`,
        createdById: ownerId,
        generalAccessRole: GeneralAccessRole.VIEWER,
      },
    });
    nodeId = node.id;
    nodeIds.push(nodeId);
    await prisma.permissionEntry.createMany({
      data: [
        { nodeId, userId: ownerId, role: DocumentRole.OWNER },
        { nodeId, userId: editorId, role: DocumentRole.EDITOR },
      ],
    });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { resourceId: { in: nodeIds } } });
    await prisma.permissionEntry.deleteMany({ where: { nodeId: { in: nodeIds } } });
    await prisma.node.deleteMany({ where: { id: { in: nodeIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, editorId, noAclId] } } });
    await prisma.$disconnect();
  });

  it('resolves one stable Node UUID through mutable General Access and ACL policy', async () => {
    const id = nodeId;
    await expect(access.resolve(id, undefined, DocumentCapability.VIEW)).resolves.toMatchObject({ mode: 'PUBLIC' });
    await prisma.node.update({ where: { id }, data: { generalAccessRole: GeneralAccessRole.EDITOR } });
    await expect(access.resolve(id, undefined, DocumentCapability.EDIT)).resolves.toMatchObject({ generalAccessRole: GeneralAccessRole.EDITOR });
    await prisma.node.update({ where: { id }, data: { generalAccessRole: GeneralAccessRole.RESTRICTED } });
    await expect(access.resolve(id, undefined, DocumentCapability.VIEW)).rejects.toMatchObject({ status: 401 });
    await expect(access.resolve(id, { userId: ownerId, sessionId: randomUUID() }, DocumentCapability.VIEW)).resolves.toMatchObject({ node: { id } });
    await expect(access.resolve(id, { userId: editorId, sessionId: randomUUID() }, DocumentCapability.EDIT)).resolves.toMatchObject({ node: { id } });
    await expect(access.resolve(id, { userId: noAclId, sessionId: randomUUID() }, DocumentCapability.VIEW)).rejects.toMatchObject({ status: 403 });
    await prisma.node.update({ where: { id }, data: { generalAccessRole: GeneralAccessRole.VIEWER } });
    const strongerAcl = await access.resolve(id, { userId: editorId, sessionId: randomUUID() }, DocumentCapability.VIEW);
    expect(strongerAcl.node.id).toBe(id);
    expect(strongerAcl.capabilities.has(DocumentCapability.EDIT)).toBe(true);
  });
});
