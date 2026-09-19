import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DocumentRole,
  NodeType,
  prisma,
  SystemRole,
  UserStatus,
} from '@dochub/database';
import request from 'supertest';
import { App } from 'supertest/types';
import { AccessTokenGuard } from '../src/auth/access-token.guard.js';
import { AppModule } from '../src/app.module.js';

describe('streaming file uploads (e2e)', () => {
  const suffix = randomUUID();
  const actorId = randomUUID();
  const sessionId = randomUUID();
  const nodes: string[] = [];
  let app: INestApplication<App>;
  let root: string;
  let storageRoot: string;
  let tempRoot: string;
  const previousEnv = {
    STORAGE_DRIVER: process.env.STORAGE_DRIVER,
    STORAGE_ROOT: process.env.STORAGE_ROOT,
    UPLOAD_TEMP_ROOT: process.env.UPLOAD_TEMP_ROOT,
    UPLOAD_MAX_BYTES: process.env.UPLOAD_MAX_BYTES,
  };

  beforeAll(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'dochub-upload-storage-'));
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dochub-upload-temp-'));
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_ROOT = storageRoot;
    process.env.UPLOAD_TEMP_ROOT = tempRoot;
    process.env.UPLOAD_MAX_BYTES = '1024';
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate(context: { switchToHttp(): { getRequest(): { auth?: unknown } } }) {
          context.switchToHttp().getRequest().auth = { userId: actorId, sessionId };
          return true;
        },
      })
      .compile();
    app = fixture.createNestApplication();
    await app.init();
    await prisma.user.create({
      data: {
        id: actorId,
        email: `upload-${suffix}@example.test`,
        normalizedEmail: `upload-${suffix}@example.test`,
        displayName: 'Upload administrator',
        status: UserStatus.ACTIVE,
        systemRole: SystemRole.ADMIN,
      },
    });
    const parent = await prisma.node.create({
      data: {
        type: NodeType.FOLDER,
        name: `upload-parent-${suffix}`,
        normalizedName: `upload-parent-${suffix}`,
        createdById: actorId,
      },
    });
    root = parent.id;
    nodes.push(root);
    await prisma.permissionEntry.create({
      data: { nodeId: root, userId: actorId, role: DocumentRole.OWNER },
    });
  });

  afterAll(async () => {
    const files = await prisma.file.findMany({
      where: { nodeId: { in: nodes } },
      select: { id: true },
    });
    const versionIds = (
      await prisma.fileVersion.findMany({
        where: { fileId: { in: files.map((file) => file.id) } },
        select: { id: true },
      })
    ).map((version) => version.id);
    await prisma.auditLog.deleteMany({
      where: { OR: [{ resourceId: { in: nodes } }, { resourceId: { in: versionIds } }] },
    });
    await prisma.permissionEntry.deleteMany({ where: { nodeId: { in: nodes } } });
    for (const file of files) {
      await prisma.file.update({ where: { id: file.id }, data: { currentVersionId: null } });
    }
    await prisma.fileVersion.deleteMany({ where: { fileId: { in: files.map((file) => file.id) } } });
    await prisma.file.deleteMany({ where: { id: { in: files.map((file) => file.id) } } });
    await prisma.node.deleteMany({ where: { id: { in: nodes } } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await app.close();
    await Promise.all([rm(storageRoot, { recursive: true, force: true }), rm(tempRoot, { recursive: true, force: true })]);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('persists an initial upload binary-first, creates owner/audit metadata, and hides storage addressing', async () => {
    const bytes = Buffer.from('%PDF-1.7\ninitial upload');
    const response = await request(app.getHttpServer())
      .post('/files')
      .field('parentId', root)
      .attach('file', bytes, { filename: 'C:\\fakepath\\report.pdf', contentType: 'application/pdf' })
      .expect(201);
    nodes.push(response.body.node.id);
    expect(response.body).toMatchObject({
      node: { type: 'FILE', name: 'report.pdf', parentId: root },
      file: { currentVersionId: response.body.version.id },
      version: { versionNumber: 1, mimeType: 'application/pdf', extension: 'pdf', sizeBytes: String(bytes.length) },
    });
    expect(response.body.version).not.toHaveProperty('storageKey');
    const version = await prisma.fileVersion.findUniqueOrThrow({ where: { id: response.body.version.id } });
    expect(version.storageKey).toBe(`files/${response.body.file.id}/versions/${version.id}`);
    expect(await readFile(path.join(storageRoot, ...version.storageKey.split('/')))).toEqual(bytes);
    await expect(prisma.permissionEntry.findFirstOrThrow({
      where: { nodeId: response.body.node.id, userId: actorId, role: DocumentRole.OWNER },
    })).resolves.toBeTruthy();
    await expect(prisma.auditLog.findFirstOrThrow({
      where: { resourceId: response.body.node.id, action: 'FILE_UPLOADED' },
    })).resolves.toBeTruthy();
  });

  it('returns stable multipart errors and cleans temporary files', async () => {
    await request(app.getHttpServer()).post('/files').field('parentId', root).expect(400);
    await request(app.getHttpServer())
      .post('/files').field('parentId', root)
      .attach('file', Buffer.from('%PDF-'), 'one.pdf')
      .attach('file', Buffer.from('%PDF-'), 'two.pdf')
      .expect(400);
    await request(app.getHttpServer())
      .post('/files').field('parentId', root)
      .attach('file', Buffer.alloc(1025), 'large.pdf')
      .expect(413);
    await request(app.getHttpServer())
      .post('/files').field('parentId', root)
      .attach('file', Buffer.from('%PDF-1.7'), 'wrong.png')
      .expect(415);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('serializes concurrent version numbers with a PostgreSQL row lock', async () => {
    const initial = await request(app.getHttpServer())
      .post('/files').field('parentId', root)
      .attach('file', Buffer.from('%PDF-1.7\nversion one'), 'versions.pdf')
      .expect(201);
    nodes.push(initial.body.node.id);
    const [left, right] = await Promise.all([
      request(app.getHttpServer()).post(`/nodes/${initial.body.node.id}/versions`)
        .attach('file', Buffer.from('%PDF-1.7\nversion two'), 'two.pdf'),
      request(app.getHttpServer()).post(`/nodes/${initial.body.node.id}/versions`)
        .attach('file', Buffer.from('%PDF-1.7\nversion three'), 'three.pdf'),
    ]);
    expect([left.status, right.status]).toEqual([201, 201]);
    const file = await prisma.file.findUniqueOrThrow({
      where: { id: initial.body.file.id },
      include: { versions: { orderBy: { versionNumber: 'asc' } } },
    });
    expect(file.versions.map((version) => version.versionNumber)).toEqual([1, 2, 3]);
    expect(file.versionCounter).toBe(3);
    expect([left.body.version.id, right.body.version.id]).toContain(
      file.currentVersionId,
    );
    expect(await Promise.all(file.versions.map((version) => readFile(path.join(storageRoot, ...version.storageKey.split('/')))))).toHaveLength(3);
  });
});
