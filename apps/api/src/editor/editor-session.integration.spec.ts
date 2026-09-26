import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { DocumentRole, NodeType, prisma, UserStatus } from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { EditorConfig } from './editor.config.js';
import { EditorSessionService } from './editor-session.service.js';

const withDb = process.env.DATABASE_URL ? describe : describe.skip;
withDb('EditorSessionService integration', () => {
  const suffix = randomUUID();
  const actorId = randomUUID();
  const outsiderId = randomUUID();
  const nodeId = randomUUID();
  const fileId = randomUUID();
  const versionIds: string[] = [];
  const config: EditorConfig = {
    publicUrl: new URL('http://localhost:8082'),
    internalApiUrl: new URL('http://host.docker.internal:3000'),
    jwtSecret: 'a'.repeat(32), fetchTokenSecret: 'b'.repeat(32), fetchTokenTtlSeconds: 900,
  };
  const database = { prisma } as unknown as DatabaseService;
  const authorization = new DocumentAuthorizationService(database);
  const service = new EditorSessionService(database, authorization, new JwtService(), config);

  async function version(number: number) {
    const id = randomUUID();
    versionIds.push(id);
    await prisma.fileVersion.create({ data: {
      id, fileId, versionNumber: number, storageKey: `editor/${id}`,
      originalFilename: `brief-${number}.docx`, extension: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 4n, sha256: id.replaceAll('-', '').padEnd(64, '0'), source: 'UPLOAD', createdById: actorId,
    }});
    await prisma.file.update({ where: { id: fileId }, data: { currentVersionId: id, versionCounter: number } });
    return id;
  }

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: actorId, email: `editor-${suffix}@test`, normalizedEmail: `editor-${suffix}@test`, displayName: 'Editor Viewer', status: UserStatus.ACTIVE },
      { id: outsiderId, email: `editor-out-${suffix}@test`, normalizedEmail: `editor-out-${suffix}@test`, displayName: 'No Access', status: UserStatus.ACTIVE },
    ]});
    await prisma.node.create({ data: { id: nodeId, type: NodeType.FILE, name: `brief-${suffix}.docx`, normalizedName: `brief-${suffix}`, createdById: actorId } });
    await prisma.permissionEntry.create({ data: { nodeId, userId: actorId, role: DocumentRole.VIEWER } });
    await prisma.file.create({ data: { id: fileId, nodeId } });
    await version(1);
  });
  afterAll(async () => {
    await prisma.editorSession.deleteMany({ where: { fileId } });
    await prisma.file.update({ where: { id: fileId }, data: { currentVersionId: null } });
    await prisma.fileVersion.deleteMany({ where: { id: { in: versionIds } } });
    await prisma.file.delete({ where: { id: fileId } });
    await prisma.permissionEntry.deleteMany({ where: { nodeId } });
    await prisma.node.delete({ where: { id: nodeId } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, outsiderId] } } });
    await prisma.$disconnect();
  });

  it('creates an immutable VIEW snapshot with signed, non-secret config', async () => {
    const created = await service.create(actorId, nodeId);
    expect(created.session).toMatchObject({ mode: 'VIEW', status: 'ACTIVE', expiresAt: null });
    expect(created.config).toMatchObject({ documentType: 'word', document: { fileType: 'docx', permissions: { edit: false, download: true, print: true } }, editorConfig: { mode: 'view', user: { id: actorId } } });
    expect(JSON.stringify(created)).not.toContain(config.jwtSecret);
    expect(JSON.stringify(created)).not.toContain(config.fetchTokenSecret);
    const signedConfig = await new JwtService().verifyAsync(created.config.token, {
      secret: config.jwtSecret,
      algorithms: ['HS256'],
    });
    expect(signedConfig).toMatchObject({ documentType: 'word', editorConfig: { mode: 'view' } });
    await expect(
      new JwtService().verifyAsync(`${created.config.token}x`, { secret: config.jwtSecret }),
    ).rejects.toBeTruthy();
    const persisted = await prisma.editorSession.findUniqueOrThrow({ where: { id: created.session.id } });
    expect(persisted.baseVersionId).toBe(versionIds[0]);
    expect(persisted.documentKey).toBe(EditorSessionService.documentKey(versionIds[0]));
    await expect(service.create(outsiderId, nodeId)).rejects.toMatchObject({ status: 404 });
  });

  it('keeps old sessions on V1 and makes a new key for V2', async () => {
    const first = await service.create(actorId, nodeId);
    const v2 = await version(2);
    const second = await service.create(actorId, nodeId);
    expect(first.config.document.key).not.toBe(second.config.document.key);
    const firstRow = await prisma.editorSession.findUniqueOrThrow({ where: { id: first.session.id } });
    const secondRow = await prisma.editorSession.findUniqueOrThrow({ where: { id: second.session.id } });
    expect(firstRow.baseVersionId).toBe(versionIds[0]);
    expect(secondRow.baseVersionId).toBe(v2);
  });

  it('validates fetch capabilities before a caller can open storage', async () => {
    const created = await service.create(actorId, nodeId);
    const source = new URL(created.config.document.url);
    const token = source.searchParams.get('token')!;
    await expect(service.authorizeFetch(created.session.id, token)).resolves.toMatchObject({ nodeId, versionId: versionIds.at(-1) });
    await expect(service.authorizeFetch(randomUUID(), token)).rejects.toMatchObject({ status: 404 });
    await expect(service.authorizeFetch(created.session.id, `${token}x`)).rejects.toMatchObject({ status: 404 });
    await service.close(actorId, created.session.id);
    await expect(service.close(actorId, created.session.id)).resolves.toMatchObject({ status: 'CLOSED' });
    await expect(service.authorizeFetch(created.session.id, token)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects expired, wrong-version, wrong-audience, revoked, and trashed fetches', async () => {
    const created = await service.create(actorId, nodeId);
    const token = new URL(created.config.document.url).searchParams.get('token')!;
    const jwt = new JwtService();
    const forge = (payload: object, options: object = {}) =>
      jwt.sign({ aud: 'onlyoffice-file-fetch', sessionId: created.session.id, fileVersionId: versionIds.at(-1), purpose: 'onlyoffice-file-fetch', ...payload }, { secret: config.fetchTokenSecret, algorithm: 'HS256', ...options });
    await expect(service.authorizeFetch(created.session.id, forge({}, { expiresIn: -1 }))).rejects.toMatchObject({ status: 404 });
    await expect(service.authorizeFetch(created.session.id, forge({ fileVersionId: randomUUID() }))).rejects.toMatchObject({ status: 404 });
    await expect(service.authorizeFetch(created.session.id, forge({ aud: 'wrong-audience' }))).rejects.toMatchObject({ status: 404 });
    await prisma.permissionEntry.deleteMany({ where: { nodeId, userId: actorId } });
    await expect(service.authorizeFetch(created.session.id, token)).rejects.toMatchObject({ status: 404 });
    await prisma.permissionEntry.create({ data: { nodeId, userId: actorId, role: DocumentRole.VIEWER } });
    const operation = await prisma.trashOperation.create({ data: { rootNodeId: nodeId, trashedById: actorId, expiresAt: new Date(Date.now() + 60_000) } });
    await prisma.node.update({ where: { id: nodeId }, data: { trashOperationId: operation.id } });
    await expect(service.authorizeFetch(created.session.id, token)).rejects.toMatchObject({ status: 404 });
    await prisma.node.update({ where: { id: nodeId }, data: { trashOperationId: null } });
    await prisma.trashOperation.delete({ where: { id: operation.id } });
  });
});
