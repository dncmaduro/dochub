import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentRole, FileVersionSource, NodeType, prisma, SystemRole, UserStatus } from '@dochub/database';
import { LocalFileStorage } from '@dochub/storage';
import { AppModule } from '../app.module.js';
import { AuthSessionService } from '../auth/auth-session.service.js';

const withDatabase = process.env.DATABASE_URL ? describe : describe.skip;
withDatabase('preview HTTP integration', () => {
  const suffix = randomUUID(), userId = randomUUID(), viewerId = randomUUID(), deniedUserId = randomUUID(), adminId = randomUUID(), nodeId = randomUUID(), fileId = randomUUID(), bytes = Buffer.from('preview-http-bytes');
  let app: INestApplication, root: string, versionId: string, storageKey: string, accessToken: string, viewerAccessToken: string, deniedAccessToken: string, adminAccessToken: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'dochub-preview-http-'));
    Object.assign(process.env, { AUTH_ACCESS_TOKEN_SECRET: 'preview-http-test-secret', STORAGE_DRIVER: 'local', STORAGE_ROOT: root, UPLOAD_TEMP_ROOT: path.join(root, 'uploads'), UPLOAD_MAX_BYTES: '1048576' });
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication(); app.use(cookieParser()); await app.init(); await app.listen(0, '127.0.0.1');
    await prisma.user.createMany({ data: [
      { id: userId, email: `preview-${suffix}@x.test`, normalizedEmail: `preview-${suffix}@x.test`, displayName: 'Preview HTTP', status: UserStatus.ACTIVE },
      { id: viewerId, email: `preview-viewer-${suffix}@x.test`, normalizedEmail: `preview-viewer-${suffix}@x.test`, displayName: 'Preview Viewer', status: UserStatus.ACTIVE },
      { id: deniedUserId, email: `preview-denied-${suffix}@x.test`, normalizedEmail: `preview-denied-${suffix}@x.test`, displayName: 'Preview Denied', status: UserStatus.ACTIVE },
      { id: adminId, email: `preview-admin-${suffix}@x.test`, normalizedEmail: `preview-admin-${suffix}@x.test`, displayName: 'Preview Admin', status: UserStatus.ACTIVE, systemRole: SystemRole.ADMIN },
    ] });
    await prisma.node.create({ data: { id: nodeId, type: NodeType.FILE, name: 'preview.pdf', normalizedName: `preview-${suffix}`, createdById: userId } }); await prisma.permissionEntry.createMany({ data: [{ nodeId, userId, role: DocumentRole.OWNER }, { nodeId, userId: viewerId, role: DocumentRole.VIEWER }] }); await prisma.file.create({ data: { id: fileId, nodeId } });
    versionId = randomUUID(); storageKey = `files/${fileId}/versions/${versionId}`; await new LocalFileStorage(root).putStream(storageKey, Readable.from(bytes));
    await prisma.fileVersion.create({ data: { id: versionId, fileId, versionNumber: 1, storageKey, originalFilename: 'preview.pdf', mimeType: 'application/pdf', sizeBytes: BigInt(bytes.length), sha256: createHash('sha256').update(bytes).digest('hex'), source: FileVersionSource.UPLOAD, createdById: userId } }); await prisma.file.update({ where: { id: fileId }, data: { currentVersionId: versionId, versionCounter: 1 } });
    const sessions = app.get(AuthSessionService);
    accessToken = (await sessions.createSession({ userId })).accessToken;
    viewerAccessToken = (await sessions.createSession({ userId: viewerId })).accessToken;
    deniedAccessToken = (await sessions.createSession({ userId: deniedUserId })).accessToken;
    adminAccessToken = (await sessions.createSession({ userId: adminId })).accessToken;
  });
  afterAll(async () => { await prisma.session.deleteMany({ where: { userId: { in: [userId, viewerId, deniedUserId, adminId] } } }); await prisma.permissionEntry.deleteMany({ where: { nodeId } }); await prisma.file.updateMany({ where: { id: fileId }, data: { currentVersionId: null } }); await prisma.fileVersion.deleteMany({ where: { fileId } }); await prisma.file.deleteMany({ where: { id: fileId } }); await prisma.node.deleteMany({ where: { id: nodeId } }); await prisma.user.deleteMany({ where: { id: { in: [userId, viewerId, deniedUserId, adminId] } } }); await app?.close(); await rm(root, { recursive: true, force: true }); await prisma.$disconnect(); });
  it('creates a session and streams exact bytes through HTTP', async () => {
    const created = await request(app.getHttpServer()).post(`/nodes/${nodeId}/preview-session`).set('Authorization', `Bearer ${accessToken}`).expect(201); expect(created.body).toMatchObject({ contentUrl: expect.stringMatching(/^\/preview\/[0-9a-f-]+\/content$/), mimeType: 'application/pdf' }); expect(JSON.stringify(created.body)).not.toContain(storageKey); expect(created.body).not.toHaveProperty('token'); const cookie = created.headers['set-cookie']?.[0]; expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/Max-Age=300/);
    const content = await request(app.getHttpServer()).get(created.body.contentUrl).set('Cookie', cookie).buffer(true).parse((res, done) => { const parts: Buffer[] = []; res.on('data', (p) => parts.push(p)); res.on('end', () => done(null, Buffer.concat(parts))); }).expect(200); expect(content.body).toEqual(bytes); expect(content.headers['content-type']).toMatch(/^application\/pdf/); expect(content.headers['content-disposition']).toMatch(/^inline/);
    const range = await request(app.getHttpServer()).get(created.body.contentUrl).set('Cookie', cookie).set('Range', 'bytes=0-6').buffer(true).parse((res, done) => { const parts: Buffer[] = []; res.on('data', (p) => parts.push(p)); res.on('end', () => done(null, Buffer.concat(parts))); }).expect(206); expect(range.body).toEqual(bytes.subarray(0, 7)); expect(range.headers['content-range']).toBe(`bytes 0-6/${bytes.length}`);
  });
  it('allows a normal Viewer and denies users and system administrators without document ACL', async () => {
    const node = await request(app.getHttpServer()).get(`/nodes/${nodeId}`).set('Authorization', `Bearer ${viewerAccessToken}`).expect(200);
    expect(node.body.capabilities).toEqual(expect.arrayContaining(['VIEW', 'PREVIEW', 'DOWNLOAD']));
    await request(app.getHttpServer()).post(`/nodes/${nodeId}/preview-session`).set('Authorization', `Bearer ${viewerAccessToken}`).expect(201);
    await request(app.getHttpServer()).post(`/nodes/${nodeId}/preview-session`).set('Authorization', `Bearer ${deniedAccessToken}`).expect(404);
    await request(app.getHttpServer()).post(`/nodes/${nodeId}/preview-session`).set('Authorization', `Bearer ${adminAccessToken}`).expect(404);
  });
  it('rejects invalid and expired preview capabilities', async () => {
    await request(app.getHttpServer()).get('/preview/not-a-session/content').expect(401);
    const token = await app.get(JwtService).signAsync({ typ: 'preview', sid: 'expired', sub: userId, nid: nodeId, vid: versionId }, { audience: 'dochub-preview', expiresIn: -1 });
    await request(app.getHttpServer()).get('/preview/expired/content').set('Cookie', `dochub_preview_expired=${token}`).expect(401);
  });
});
