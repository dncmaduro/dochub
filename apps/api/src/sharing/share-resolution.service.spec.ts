import { createHash } from 'node:crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NodeType } from '@dochub/database';
import { describe, expect, it, vi } from 'vitest';
import { DocumentCapability } from '../authorization/document-capability.js';
import { ShareResolutionService } from './share-resolution.service.js';

const token = 'A'.repeat(43);
const node = {
  id: 'n',
  type: NodeType.FILE,
  name: 'public.pdf',
  publicAccess: true,
  trashOperationId: null,
};

function resolutionFixture(
  input: {
    publicAccess?: boolean;
    capabilities?: Set<DocumentCapability>;
    link?: boolean;
  } = {},
) {
  const database = {
    prisma: {
      shareLink: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            input.link === false
              ? null
              : { node: { ...node, publicAccess: input.publicAccess ?? true } },
          ),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ trashOperationId: null }]),
    },
  };
  const authorization = {
    resolveCapabilities: vi
      .fn()
      .mockResolvedValue({
        capabilities:
          input.capabilities ??
          new Set([DocumentCapability.VIEW, DocumentCapability.PREVIEW]),
      }),
  };
  return {
    service: new ShareResolutionService(
      database as never,
      authorization as never,
    ),
    database,
    authorization,
  };
}

describe('ShareResolutionService', () => {
  it('hashes opaque tokens for active-link lookup and returns limited public access', async () => {
    const { service, database } = resolutionFixture();
    await expect(
      service.resolve(token, undefined, DocumentCapability.PREVIEW),
    ).resolves.toMatchObject({
      mode: 'PUBLIC',
      node: { id: 'n', name: 'public.pdf' },
    });
    expect(database.prisma.shareLink.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tokenHash: createHash('sha256').update(token).digest('hex'),
          revokedAt: null,
        },
      }),
    );
  });

  it('hides invalid links and private public requests, and forbids public download', async () => {
    await expect(
      resolutionFixture({ link: false }).service.resolve(
        token,
        undefined,
        DocumentCapability.VIEW,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      resolutionFixture({ publicAccess: false }).service.resolve(
        token,
        undefined,
        DocumentCapability.VIEW,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      resolutionFixture().service.resolve(
        token,
        undefined,
        DocumentCapability.DOWNLOAD,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('uses authenticated ACL only without public fallback', async () => {
    const auth = { userId: 'u', sessionId: 's' };
    await expect(
      resolutionFixture({ capabilities: new Set() }).service.resolve(
        token,
        auth,
        DocumentCapability.VIEW,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      resolutionFixture().service.resolve(
        token,
        auth,
        DocumentCapability.PREVIEW,
      ),
    ).resolves.toMatchObject({ mode: 'AUTHENTICATED' });
  });
});
