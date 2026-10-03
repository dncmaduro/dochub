import { describe, expect, it, vi } from 'vitest';
import { DocumentCapability } from '../authorization/document-capability.js';
import { PreviewService } from './preview.service.js';

describe('PreviewService', () => {
  it('creates a version-bound capability without returning its secret', async () => {
    const authorization = { resolveCapabilities: vi.fn().mockResolvedValue({ capabilities: new Set([DocumentCapability.VIEW]) }) };
    const database = { prisma: { node: { findFirst: vi.fn().mockResolvedValue({ id: 'node', name: 'x.pdf', file: { currentVersion: { id: 'version', mimeType: 'application/pdf', sizeBytes: 3n } } }) } } };
    const jwt = { signAsync: vi.fn().mockResolvedValue('signed-preview') };
    const service = new PreviewService(database as never, authorization as never, jwt as never);
    const preview = await service.create('user', 'node');
    expect(preview).toMatchObject({ nodeId: 'node', contentUrl: expect.stringMatching(/^\/preview\//), mimeType: 'application/pdf', filename: 'x.pdf', size: '3' });
    expect(preview).toHaveProperty('token', 'signed-preview');
    expect(jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({ typ: 'preview', sub: 'user', nid: 'node', vid: 'version' }), expect.objectContaining({ audience: 'dochub-preview' }));
  });

  it('does not create a session for an unsupported MIME type', async () => {
    const authorization = { resolveCapabilities: vi.fn().mockResolvedValue({ capabilities: new Set([DocumentCapability.VIEW]) }) };
    const database = { prisma: { node: { findFirst: vi.fn().mockResolvedValue({ id: 'node', name: 'x.bin', file: { currentVersion: { id: 'version', mimeType: 'application/octet-stream', sizeBytes: 3n } } }) } } };
    const service = new PreviewService(database as never, authorization as never, {} as never);
    await expect(service.create('user', 'node')).resolves.toBeNull();
  });
});
