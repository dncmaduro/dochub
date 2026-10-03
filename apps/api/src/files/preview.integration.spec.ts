import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentRole, FileVersionSource, NodeType, prisma, UserStatus } from '@dochub/database';
import { LocalFileStorage } from '@dochub/storage';
import { AppModule } from '../app.module.js';
import { AuthSessionService } from '../auth/auth-session.service.js';

const withDatabase = process.env.DATABASE_URL ? describe : describe.skip;
withDatabase('preview HTTP integration', () => {
  const suffix = randomUUID(), userId = randomUUID(), nodeId = randomUUID(), fileId = randomUUID(), bytes = Buffer.from('preview-http-bytes');
  let app: INestApplication, root: string, versionId: string, accessToken: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'dochub-preview-http-'));
    Object.assign(process.env, { AUTH_ACCESS_TOKEN_SECRET: 'preview-http-test-secret', STORAGE_DRIVER: 'local', STORAGE_ROOT: root, UPLOAD_TEMP_ROOT: root, UPLOAD_MAX_BYTES: '1048576' });
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication(); app.use(cookieParser()); await app.init(); await app.listen(0, '127.0.0.1');
    await prisma.user.create({ data: { id: userId, email: `preview-${suffix}@x.test`, normalizedEmail: `preview-${suffix}@x.test`, displayName: 'Preview HTTP', status: UserStatus.ACTIVE } });
    await prisma.node.create({ data: { id: nodeId, type: NodeType.FILE, name: 'preview.pdf', normalizedName: `preview-${suffix}`, createdById: userId } }); await prisma.permissionEntry.create({ data: { nodeId, userId, role: DocumentRole.OWNER } }); await prisma.file.create({ data: { id: fileId, nodeId } });
    versionId = randomUUID(); const storageKey = `files/${fileId}/versions/${versionId}`; await new LocalFileStorage(root).putStream(storageKey, Readable.from(bytes));
    await prisma.fileVersion.create({ data: { id: versionId, fileId, versionNumber: 1, storageKey, originalFilename: 'preview.pdf', mimeType: 'application/pdf', sizeBytes: BigInt(bytes.length), sha256: createHash('sha256').update(bytes).digest('hex'), source: FileVersionSource.UPLOAD, createdById: userId } }); await prisma.file.update({ where: { id: fileId }, data: { currentVersionId: versionId, versionCounter: 1 } }); accessToken = (await app.get(AuthSessionService).createSession({ userId })).accessToken;
  });
  afterAll(async () => { await prisma.session.deleteMany({ where: { userId } }); await prisma.permissionEntry.deleteMany({ where: { nodeId } }); await prisma.file.updateMany({ where: { id: fileId }, data: { currentVersionId: null } }); await prisma.fileVersion.deleteMany({ where: { fileId } }); await prisma.file.deleteMany({ where: { id: fileId } }); await prisma.node.deleteMany({ where: { id: nodeId } }); await prisma.user.deleteMany({ where: { id: userId } }); await app?.close(); await rm(root, { recursive: true, force: true }); await prisma.$disconnect(); });
  it('creates a session and streams exact bytes through HTTP', async () => {
    const created = await request(app.getHttpServer()).post(`/nodes/${nodeId}/preview-session`).set('Authorization', `Bearer ${accessToken}`).expect(201); expect(created.body).toMatchObject({ contentUrl: expect.stringMatching(/^\/preview\/[0-9a-f-]+\/content$/), mimeType: 'application/pdf' }); expect(created.body).not.toHaveProperty('token'); const cookie = created.headers['set-cookie']?.[0]; expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/Max-Age=300/);
    const content = await request(app.getHttpServer()).get(created.body.contentUrl).set('Cookie', cookie).buffer(true).parse((res, done) => { const parts: Buffer[] = []; res.on('data', (p) => parts.push(p)); res.on('end', () => done(null, Buffer.concat(parts))); }).expect(200); expect(content.body).toEqual(bytes); expect(content.headers['content-type']).toMatch(/^application\/pdf/); expect(content.headers['content-disposition']).toMatch(/^inline/);
  });
});
