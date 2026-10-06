import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { GeneralAccessRole, NodeType } from '@dochub/database';
import { describe, expect, it, vi } from 'vitest';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DocumentAccessService } from './document-access.service.js';

const nodeId = '11111111-1111-4111-8111-111111111111';
const node = {
  id: nodeId,
  type: NodeType.FILE,
  name: 'report.docx',
  generalAccessRole: GeneralAccessRole.VIEWER,
  file: { currentVersion: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } },
};

function fixture(input: {
  role?: GeneralAccessRole;
  acl?: Set<DocumentCapability>;
  exists?: boolean;
} = {}) {
  const prisma = {
    node: {
      findFirst: vi.fn().mockResolvedValue(
        input.exists === false
          ? null
          : { ...node, generalAccessRole: input.role ?? node.generalAccessRole },
      ),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn().mockResolvedValue([{ trashOperationId: null }]),
  };
  const authorization = {
    resolveCapabilities: vi.fn().mockResolvedValue({
      capabilities: input.acl ?? new Set<DocumentCapability>(),
    }),
  };
  return {
    service: new DocumentAccessService({ prisma } as never, authorization as never),
    prisma,
    authorization,
  };
}

describe('DocumentAccessService', () => {
  it('grants Viewer access through General Access without a bearer URL token', async () => {
    const { service, prisma } = fixture();
    const resolved = await service.resolve(nodeId, undefined, DocumentCapability.VIEW);
    expect(resolved).toMatchObject({
      node: { id: nodeId, name: 'report.docx' },
      generalAccessRole: GeneralAccessRole.VIEWER,
      mode: 'PUBLIC',
    });
    expect(resolved.capabilities.has(DocumentCapability.PREVIEW)).toBe(true);
    expect(resolved.capabilities.has(DocumentCapability.EDIT)).toBe(false);
    expect(prisma.node.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: nodeId, trashOperationId: null } }));
  });

  it('grants Editor capability only while the same document policy is Editor', async () => {
    const { service } = fixture({ role: GeneralAccessRole.EDITOR });
    await expect(
      service.resolve(nodeId, undefined, DocumentCapability.EDIT),
    ).resolves.toMatchObject({ mode: 'PUBLIC', generalAccessRole: GeneralAccessRole.EDITOR });
    await expect(
      service.resolve(nodeId, undefined, DocumentCapability.DOWNLOAD),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies anonymous Restricted access and allows an authorized user ACL', async () => {
    const restricted = fixture({ role: GeneralAccessRole.RESTRICTED });
    await expect(
      restricted.service.resolve(nodeId, undefined, DocumentCapability.VIEW),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const authorized = fixture({
      role: GeneralAccessRole.RESTRICTED,
      acl: new Set([DocumentCapability.VIEW, DocumentCapability.PREVIEW]),
    });
    await expect(
      authorized.service.resolve(
        nodeId,
        { userId: 'user-id', sessionId: 'session-id' },
        DocumentCapability.VIEW,
      ),
    ).resolves.toMatchObject({ mode: 'AUTHENTICATED' });
  });

  it('keeps stronger authenticated ACL capabilities when General Access is Viewer', async () => {
    const { service, authorization } = fixture({
      acl: new Set([
        DocumentCapability.VIEW,
        DocumentCapability.PREVIEW,
        DocumentCapability.EDIT,
      ]),
    });
    const resolved = await service.resolve(
      nodeId,
      { userId: 'user-id', sessionId: 'session-id' },
      DocumentCapability.EDIT,
    );
    expect(resolved.capabilities.has(DocumentCapability.EDIT)).toBe(true);
    expect(authorization.resolveCapabilities).toHaveBeenCalledWith('user-id', nodeId);
  });

  it('hides missing documents and rejects malformed identifiers', async () => {
    await expect(
      fixture({ exists: false }).service.resolve(nodeId, undefined, DocumentCapability.VIEW),
    ).rejects.toBeInstanceOf(NotFoundException);
    const { service, prisma } = fixture();
    await expect(
      service.resolve('not-a-document-id', undefined, DocumentCapability.VIEW),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.node.findFirst).not.toHaveBeenCalled();
  });
});
