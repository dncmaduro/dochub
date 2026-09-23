import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
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
  const aclLessAdminId = randomUUID();
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
    storageRoot = await mkdtemp(
      path.join(os.tmpdir(), 'dochub-upload-storage-'),
    );
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dochub-upload-temp-'));
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_ROOT = storageRoot;
    process.env.UPLOAD_TEMP_ROOT = tempRoot;
    process.env.UPLOAD_MAX_BYTES = '1024';
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate(context: {
          switchToHttp(): {
            getRequest(): {
              auth?: unknown;
              header(name: string): string | undefined;
            };
          };
        }) {
          const request = context.switchToHttp().getRequest();
          request.auth = {
            userId: request.header('x-test-user') ?? actorId,
            sessionId,
          };
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
    await prisma.user.create({
      data: {
        id: aclLessAdminId,
        email: `acl-less-admin-${suffix}@example.test`,
        normalizedEmail: `acl-less-admin-${suffix}@example.test`,
        displayName: 'ACL-less administrator',
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
      where: {
        OR: [{ resourceId: { in: nodes } }, { resourceId: { in: versionIds } }],
      },
    });
    await prisma.permissionEntry.deleteMany({
      where: { nodeId: { in: nodes } },
    });
    await prisma.node.updateMany({
      where: { id: { in: nodes } },
      data: { trashOperationId: null },
    });
    await prisma.trashOperation.deleteMany({
      where: { rootNodeId: { in: nodes } },
    });
    for (const file of files) {
      await prisma.file.update({
        where: { id: file.id },
        data: { currentVersionId: null },
      });
    }
    await prisma.fileVersion.deleteMany({
      where: { fileId: { in: files.map((file) => file.id) } },
    });
    await prisma.file.deleteMany({
      where: { id: { in: files.map((file) => file.id) } },
    });
    await prisma.node.deleteMany({ where: { id: { in: nodes } } });
    await prisma.user.deleteMany({
      where: { id: { in: [actorId, aclLessAdminId] } },
    });
    await app.close();
    await Promise.all([
      rm(storageRoot, { recursive: true, force: true }),
      rm(tempRoot, { recursive: true, force: true }),
    ]);
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
      .attach('file', bytes, {
        filename: 'C:\\fakepath\\report.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    nodes.push(response.body.node.id);
    expect(response.body).toMatchObject({
      node: { type: 'FILE', name: 'report.pdf', parentId: root },
      file: { currentVersionId: response.body.version.id },
      version: {
        versionNumber: 1,
        mimeType: 'application/pdf',
        extension: 'pdf',
        sizeBytes: String(bytes.length),
      },
    });
    expect(response.body.version).not.toHaveProperty('storageKey');
    const version = await prisma.fileVersion.findUniqueOrThrow({
      where: { id: response.body.version.id },
    });
    expect(version.storageKey).toBe(
      `files/${response.body.file.id}/versions/${version.id}`,
    );
    expect(
      await readFile(path.join(storageRoot, ...version.storageKey.split('/'))),
    ).toEqual(bytes);
    await expect(
      prisma.permissionEntry.findFirstOrThrow({
        where: {
          nodeId: response.body.node.id,
          userId: actorId,
          role: DocumentRole.OWNER,
        },
      }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { resourceId: response.body.node.id, action: 'FILE_UPLOADED' },
      }),
    ).resolves.toBeTruthy();
  });

  it('restores a trashed file through the lifecycle route without changing its binary or version metadata', async () => {
    const bytes = Buffer.from('%PDF-1.7\nrestore fixture');
    const uploaded = await request(app.getHttpServer())
      .post('/files')
      .field('parentId', root)
      .attach('file', bytes, 'restore.pdf')
      .expect(201);
    const { node, file, version } = uploaded.body;
    nodes.push(node.id);
    const versionBefore = await prisma.fileVersion.findUniqueOrThrow({
      where: { id: version.id },
    });
    const fileBefore = await prisma.file.findUniqueOrThrow({
      where: { id: file.id },
    });
    const physicalBefore = await readFile(
      path.join(storageRoot, ...versionBefore.storageKey.split('/')),
    );

    const trashed = await request(app.getHttpServer())
      .delete(`/nodes/${node.id}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/nodes/${node.id}/content`)
      .expect(404);

    const restored = await request(app.getHttpServer())
      .post(`/trash/${trashed.body.operation.id}/restore`)
      .expect(200);
    expect(restored.body).toMatchObject({
      operation: {
        id: trashed.body.operation.id,
        rootNodeId: node.id,
        status: 'RESTORED',
      },
      restoredNodeCount: 1,
    });
    expect(
      new Date(restored.body.operation.restoredAt).getTime(),
    ).toBeGreaterThan(0);
    expect(
      await prisma.node.findUniqueOrThrow({ where: { id: node.id } }),
    ).toMatchObject({
      trashOperationId: null,
    });
    expect(
      await prisma.file.findUniqueOrThrow({ where: { id: file.id } }),
    ).toMatchObject({
      currentVersionId: fileBefore.currentVersionId,
      versionCounter: fileBefore.versionCounter,
    });
    expect(
      await prisma.fileVersion.findUniqueOrThrow({ where: { id: version.id } }),
    ).toEqual(versionBefore);
    expect(
      await readFile(
        path.join(storageRoot, ...versionBefore.storageKey.split('/')),
      ),
    ).toEqual(physicalBefore);
    await expect(
      prisma.permissionEntry.findFirstOrThrow({
        where: { nodeId: node.id, userId: actorId, role: DocumentRole.OWNER },
      }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { action: 'NODE_RESTORED', resourceId: node.id, actorId },
      }),
    ).resolves.toBeTruthy();

    const content = await request(app.getHttpServer())
      .get(`/nodes/${node.id}/content`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(content.body).toEqual(bytes);
  });

  it('returns stable multipart errors and cleans temporary files', async () => {
    await request(app.getHttpServer())
      .post('/files')
      .field('parentId', root)
      .expect(400);
    await request(app.getHttpServer())
      .post('/files')
      .field('parentId', root)
      .attach('file', Buffer.from('%PDF-'), 'one.pdf')
      .attach('file', Buffer.from('%PDF-'), 'two.pdf')
      .expect(400);
    await request(app.getHttpServer())
      .post('/files')
      .field('parentId', root)
      .attach('file', Buffer.alloc(1025), 'large.pdf')
      .expect(413);
    await request(app.getHttpServer())
      .post('/files')
      .field('parentId', root)
      .attach('file', Buffer.from('%PDF-1.7'), 'wrong.png')
      .expect(415);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('serializes concurrent version numbers with a PostgreSQL row lock', async () => {
    const initial = await request(app.getHttpServer())
      .post('/files')
      .field('parentId', root)
      .attach('file', Buffer.from('%PDF-1.7\nversion one'), 'versions.pdf')
      .expect(201);
    nodes.push(initial.body.node.id);
    const [left, right] = await Promise.all([
      request(app.getHttpServer())
        .post(`/nodes/${initial.body.node.id}/versions`)
        .attach('file', Buffer.from('%PDF-1.7\nversion two'), 'two.pdf'),
      request(app.getHttpServer())
        .post(`/nodes/${initial.body.node.id}/versions`)
        .attach('file', Buffer.from('%PDF-1.7\nversion three'), 'three.pdf'),
    ]);
    expect([left.status, right.status]).toEqual([201, 201]);
    const file = await prisma.file.findUniqueOrThrow({
      where: { id: initial.body.file.id },
      include: { versions: { orderBy: { versionNumber: 'asc' } } },
    });
    expect(file.versions.map((version) => version.versionNumber)).toEqual([
      1, 2, 3,
    ]);
    expect(file.versionCounter).toBe(3);
    expect([left.body.version.id, right.body.version.id]).toContain(
      file.currentVersionId,
    );
    expect(
      await Promise.all(
        file.versions.map((version) =>
          readFile(path.join(storageRoot, ...version.storageKey.split('/'))),
        ),
      ),
    ).toHaveLength(3);
  });

  it('streams current and historical immutable versions with secure headers and single ranges', async () => {
    const nodeId = randomUUID();
    const fileId = randomUUID();
    const v1 = randomUUID();
    const v2 = randomUUID();
    nodes.push(nodeId);
    const key = (id: string) => `files/${fileId}/versions/${id}`;
    await mkdir(path.join(storageRoot, 'files', fileId, 'versions'), {
      recursive: true,
    });
    await writeFile(
      path.join(storageRoot, ...key(v1).split('/')),
      Buffer.from('0123456789'),
    );
    await writeFile(
      path.join(storageRoot, ...key(v2).split('/')),
      Buffer.from('abcdefghij'),
    );
    await prisma.node.create({
      data: {
        id: nodeId,
        parentId: root,
        type: NodeType.FILE,
        name: 'quoted " résumé.pdf',
        normalizedName: `quoted-${suffix}`,
        createdById: actorId,
      },
    });
    await prisma.file.create({
      data: { id: fileId, nodeId, versionCounter: 2 },
    });
    await prisma.fileVersion.createMany({
      data: [
        {
          id: v1,
          fileId,
          versionNumber: 1,
          storageKey: key(v1),
          originalFilename: 'quoted " résumé.pdf',
          mimeType: 'application/pdf',
          extension: 'pdf',
          sizeBytes: 10n,
          sha256: '1'.repeat(64),
          source: 'UPLOAD',
          createdById: actorId,
        },
        {
          id: v2,
          fileId,
          versionNumber: 2,
          storageKey: key(v2),
          originalFilename: 'new.pdf',
          mimeType: 'application/pdf',
          extension: 'pdf',
          sizeBytes: 10n,
          sha256: '2'.repeat(64),
          source: 'UPLOAD',
          createdById: actorId,
        },
      ],
    });
    await prisma.file.update({
      where: { id: fileId },
      data: { currentVersionId: v2 },
    });
    const binary = (response: import('supertest').Test) =>
      response.buffer(true).parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    const current = await binary(
      request(app.getHttpServer()).get(`/nodes/${nodeId}/content`),
    ).expect(200);
    expect(current.body).toEqual(Buffer.from('abcdefghij'));
    expect(current.headers).toMatchObject({
      'content-type': 'application/pdf',
      'content-length': '10',
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    });
    expect(current.headers['content-disposition']).toContain('inline');
    const historical = await binary(
      request(app.getHttpServer()).get(
        `/nodes/${nodeId}/versions/${v1}/content`,
      ),
    ).expect(200);
    expect(historical.body).toEqual(Buffer.from('0123456789'));
    expect(historical.headers['content-disposition']).toContain('inline');
    expect(historical.headers['content-disposition']).not.toMatch(/[\r\n]/);
    const download = await binary(
      request(app.getHttpServer()).get(`/nodes/${nodeId}/download`),
    ).expect(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    for (const [range, expected, contentRange] of [
      ['bytes=2-5', '2345', 'bytes 2-5/10'],
      ['bytes=7-', '789', 'bytes 7-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'],
      ['bytes=7-999', '789', 'bytes 7-9/10'],
    ]) {
      const response = await binary(
        request(app.getHttpServer())
          .get(`/nodes/${nodeId}/versions/${v1}/content`)
          .set('Range', range),
      ).expect(206);
      expect(response.body).toEqual(Buffer.from(expected));
      expect(response.headers['content-range']).toBe(contentRange);
    }
    for (const range of [
      'bytes=10-10',
      'bytes=7-2',
      'bytes=-0',
      'bytes=abc-def',
      'items=0-1',
      'bytes=0-1,4-5',
    ]) {
      const response = await request(app.getHttpServer())
        .get(`/nodes/${nodeId}/versions/${v1}/content`)
        .set('Range', range)
        .expect(416);
      expect(response.headers['content-range']).toBe('bytes */10');
    }
    const after = await prisma.file.findUniqueOrThrow({
      where: { id: fileId },
    });
    expect(after).toMatchObject({ currentVersionId: v2, versionCounter: 2 });
  });

  it('rejects cross-file versions and treats missing, mismatched, and zero-byte objects as intended', async () => {
    const createFixture = async (bytes: Buffer | null, size: bigint) => {
      const nodeId = randomUUID(),
        fileId = randomUUID(),
        versionId = randomUUID();
      const storageKey = `files/${fileId}/versions/${versionId}`;
      nodes.push(nodeId);
      await prisma.node.create({
        data: {
          id: nodeId,
          parentId: root,
          type: NodeType.FILE,
          name: `fixture-${nodeId}.pdf`,
          normalizedName: `fixture-${nodeId}`,
          createdById: actorId,
        },
      });
      await prisma.file.create({
        data: { id: fileId, nodeId, versionCounter: 1 },
      });
      await prisma.fileVersion.create({
        data: {
          id: versionId,
          fileId,
          versionNumber: 1,
          storageKey,
          originalFilename: 'fixture.pdf',
          mimeType: 'application/pdf',
          extension: 'pdf',
          sizeBytes: size,
          sha256: 'a'.repeat(64),
          source: 'UPLOAD',
          createdById: actorId,
        },
      });
      await prisma.file.update({
        where: { id: fileId },
        data: { currentVersionId: versionId },
      });
      if (bytes !== null) {
        await mkdir(
          path.join(storageRoot, ...storageKey.split('/').slice(0, -1)),
          { recursive: true },
        );
        await writeFile(
          path.join(storageRoot, ...storageKey.split('/')),
          bytes,
        );
      }
      return { nodeId, versionId, storageKey };
    };
    const good = await createFixture(Buffer.from('0123456789'), 10n);
    const other = await createFixture(Buffer.from('abcdefghij'), 10n);
    await request(app.getHttpServer())
      .get(`/nodes/${good.nodeId}/versions/${other.versionId}/content`)
      .expect(404);
    const mismatch = await createFixture(Buffer.from('123456789'), 10n);
    const missing = await createFixture(null, 10n);
    for (const fixture of [mismatch, missing]) {
      const response = await request(app.getHttpServer())
        .get(`/nodes/${fixture.nodeId}/content`)
        .expect(503);
      expect(response.text).not.toContain(fixture.storageKey);
      expect(response.text).not.toContain(storageRoot);
      expect(response.text).not.toContain('ENOENT');
    }
    const empty = await createFixture(Buffer.alloc(0), 0n);
    const full = await request(app.getHttpServer())
      .get(`/nodes/${empty.nodeId}/content`)
      .expect(200);
    expect(full.headers['content-length']).toBe('0');
    const ranged = await request(app.getHttpServer())
      .get(`/nodes/${empty.nodeId}/content`)
      .set('Range', 'bytes=0-0')
      .expect(416);
    expect(ranged.headers['content-range']).toBe('bytes */0');
  });

  it('hides invisible/public files, hides trashed files, and rejects visible folders', async () => {
    const makeNode = async (options: {
      parentId?: string | null;
      publicAccess?: boolean;
      trashed?: boolean;
      type?: NodeType;
    }) => {
      const id = randomUUID();
      nodes.push(id);
      let trashOperationId: string | undefined;
      if (options.trashed) {
        const operation = await prisma.trashOperation.create({
          data: { expiresAt: new Date(Date.now() + 60_000) },
        });
        trashOperationId = operation.id;
      }
      await prisma.node.create({
        data: {
          id,
          parentId: options.parentId,
          type: options.type ?? NodeType.FILE,
          name: `visibility-${id}`,
          normalizedName: `visibility-${id}`,
          publicAccess: options.publicAccess,
          trashOperationId,
          createdById: actorId,
        },
      });
      return { id, trashOperationId };
    };
    const invisible = await makeNode({ parentId: null });
    const publicOnly = await makeNode({ parentId: null, publicAccess: true });
    for (const { id } of [invisible, publicOnly]) {
      await request(app.getHttpServer())
        .get(`/nodes/${id}/content`)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/nodes/${id}/download`)
        .expect(404);
    }
    const trashed = await makeNode({ parentId: root, trashed: true });
    await request(app.getHttpServer())
      .get(`/nodes/${trashed.id}/content`)
      .expect(404);
    await prisma.node.update({
      where: { id: trashed.id },
      data: { trashOperationId: null },
    });
    await prisma.trashOperation.delete({
      where: { id: trashed.trashOperationId! },
    });
    const folder = await makeNode({ parentId: root, type: NodeType.FOLDER });
    await request(app.getHttpServer())
      .get(`/nodes/${folder.id}/content`)
      .expect(409);
    await request(app.getHttpServer())
      .get(`/nodes/${folder.id}/download`)
      .expect(409);
  });

  it('does not grant a system administrator document access without an ACL', async () => {
    const nodeId = randomUUID(),
      fileId = randomUUID(),
      versionId = randomUUID();
    const storageKey = `files/${fileId}/versions/${versionId}`;
    nodes.push(nodeId);
    await mkdir(path.join(storageRoot, ...storageKey.split('/').slice(0, -1)), {
      recursive: true,
    });
    await writeFile(
      path.join(storageRoot, ...storageKey.split('/')),
      Buffer.from('admin-only-test'),
    );
    await prisma.node.create({
      data: {
        id: nodeId,
        type: NodeType.FILE,
        name: `admin-${nodeId}.pdf`,
        normalizedName: `admin-${nodeId}`,
        createdById: actorId,
      },
    });
    await prisma.file.create({
      data: { id: fileId, nodeId, versionCounter: 1 },
    });
    await prisma.fileVersion.create({
      data: {
        id: versionId,
        fileId,
        versionNumber: 1,
        storageKey,
        originalFilename: 'admin.pdf',
        mimeType: 'application/pdf',
        extension: 'pdf',
        sizeBytes: 15n,
        sha256: 'b'.repeat(64),
        source: 'UPLOAD',
        createdById: actorId,
      },
    });
    await prisma.file.update({
      where: { id: fileId },
      data: { currentVersionId: versionId },
    });
    await request(app.getHttpServer())
      .get(`/nodes/${nodeId}/content`)
      .set('x-test-user', aclLessAdminId)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/nodes/${nodeId}/download`)
      .set('x-test-user', aclLessAdminId)
      .expect(404);
  });
});
