import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { Request } from 'express';
import {
  AuditResult,
  DriveUploadOperationStatus,
  FileBackingType,
  UserStatus,
} from '@dochub/database';
import {
  ConflictException,
  ForbiddenException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { FileValidationService } from '../files/file-validation.service.js';
import { DriveProviderError } from './google-drive.provider.js';
import { DriveUploadService } from './drive-upload.service.js';

const PDF = Buffer.from('%PDF-1.7\nDocs Hub binary upload\n');
const DOCX = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from(' [Content_Types].xml word/document.xml'),
]);
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PHYSICAL_PARENT = 'google-drive-upload-target';

function multipartRequest(
  fileBytes = PDF,
  parentId: string | null = null,
  filename = 'report.pdf',
  declaredMimeType = 'application/pdf',
) {
  const boundary = `dochub-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="parentId"\r\n\r\n${parentId ?? ''}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${declaredMimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const request = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
  };
  request.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
  };
  setImmediate(() => request.end(Buffer.concat([head, fileBytes, tail])));
  return request as unknown as Request;
}

function harness(
  options: {
    role?: 'ADMIN' | 'DOCUMENT_MANAGER' | 'VIEWER';
    maxBytes?: number;
    writeAuthorized?: boolean;
    failNodeCreate?: boolean;
    failCompensation?: boolean;
  } = {},
) {
  const userId = randomUUID();
  const connectionId = randomUUID();
  const folderId = randomUUID();
  const operations = new Map<string, any>();
  const nodes = new Map<string, any>();
  const driveFiles = new Map<string, any>();
  const auditRows: any[] = [];
  const uploadCalls: any[] = [];
  const existingFolders = new Set([folderId]);
  const user = {
    id: userId,
    status: UserStatus.ACTIVE,
    systemRole: options.role ?? 'DOCUMENT_MANAGER',
  };
  let uploadedCount = 0;

  const prisma: any = {
    user: { findUnique: vi.fn(async () => user) },
    driveUploadOperation: {
      findUnique: vi.fn(
        async ({ where }: any) => operations.get(where.idempotencyKey) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          ...data,
          status: DriveUploadOperationStatus.IN_PROGRESS,
          sizeBytes: null,
          sha256: null,
          driveFileId: null,
          nodeId: null,
          errorMessage: null,
        };
        operations.set(row.idempotencyKey, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = operations.get(where.idempotencyKey);
        if (!row) throw new Error('missing upload operation');
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = operations.get(where.idempotencyKey);
        if (!row || row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    node: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.type === 'FOLDER') {
          return existingFolders.has(where.id) ? { id: where.id } : null;
        }
        return (
          [...nodes.values()].find(
            (node) =>
              node.parentId === (where.parentId ?? null) &&
              node.normalizedName === where.normalizedName,
          ) ?? null
        );
      }),
      findMany: vi.fn(async ({ where }: any) =>
        [...nodes.values()]
          .filter((node) => node.parentId === (where.parentId ?? null))
          .map((node) => ({ normalizedName: node.normalizedName })),
      ),
      create: vi.fn(async ({ data }: any) => {
        if (options.failNodeCreate)
          throw new Error('database registration failure');
        const row = { id: randomUUID(), ...data };
        nodes.set(row.id, row);
        return { id: row.id, parentId: row.parentId, name: row.name };
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const row = nodes.get(where.id);
        return row
          ? { id: row.id, parentId: row.parentId, name: row.name }
          : null;
      }),
    },
    driveFile: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.driveFileId;
        const row = driveFiles.get(key) ?? { id: randomUUID() };
        Object.assign(row, driveFiles.has(key) ? update : create);
        driveFiles.set(key, row);
        return { id: row.id };
      }),
    },
    file: {
      create: vi.fn(async ({ data }: any) => ({ id: randomUUID(), ...data })),
    },
    fileVersion: { create: vi.fn() },
    editorSession: { create: vi.fn() },
    fileProcessingTask: { create: vi.fn() },
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        auditRows.push(data);
        return data;
      }),
    },
  };
  prisma.$transaction = vi.fn(
    async (callback: (transaction: any) => Promise<unknown>) =>
      callback(prisma),
  );

  const context = {
    accessToken: 'server-only-access-token',
    integrationId: connectionId,
    target: { type: 'SHARED_DRIVE', driveId: 'company-drive', parentFolderId: PHYSICAL_PARENT },
  };
  const drive = {
    assertDriveUploadManager: vi.fn(async () => {
      if (user.systemRole === 'VIEWER') {
        throw new ForbiddenException('Document-management access is required');
      }
    }),
    withWritableDrive: vi.fn(
      async (
        _userId: string,
        callback: (value: typeof context) => Promise<unknown>,
      ) => {
        if (options.writeAuthorized === false) {
          throw new ForbiddenException({
            code: 'GOOGLE_DRIVE_WRITE_AUTHORIZATION_REQUIRED',
            message: 'Google Drive write authorization is required.',
          });
        }
        return callback(context);
      },
    ),
    uploadBinaryWithContext: vi.fn(
      async (
        receivedContext: typeof context,
        name: string,
        mimeType: string,
        source: AsyncIterable<Uint8Array>,
      ) => {
        let bytes = 0;
        for await (const chunk of source) bytes += chunk.length;
        uploadedCount += 1;
        uploadCalls.push({ context: receivedContext, name, mimeType, bytes });
        return {
          id: `drive-file-${uploadedCount}`,
          name,
          mimeType,
          parents: [PHYSICAL_PARENT],
          webViewLink: `https://drive.google.com/file/d/drive-file-${uploadedCount}/view`,
          size: String(bytes),
        };
      },
    ),
    deleteBinaryWithContext: vi.fn(async () => {
      if (options.failCompensation) throw new Error('Drive delete failed');
    }),
  };
  const service = new DriveUploadService(
    { prisma } as any,
    drive as any,
    new FileValidationService(),
    {
      driver: 'local',
      root: '/tmp/dochub-storage-test',
      uploadTempRoot: '/tmp/dochub-upload-test',
      uploadMaxBytes: options.maxBytes ?? 1024,
    },
  );
  return {
    service,
    userId,
    folderId,
    prisma,
    drive,
    context,
    operations,
    nodes,
    driveFiles,
    auditRows,
    uploadCalls,
  };
}

async function upload(
  state: ReturnType<typeof harness>,
  key: string,
  request = multipartRequest(),
) {
  return state.service.receive(state.userId, request, key);
}

describe('DriveUploadService', () => {
  it('creates a PDF as a Drive-backed root file without local version/editor artifacts', async () => {
    const state = harness({ role: 'ADMIN' });
    const result = await upload(state, 'root-upload-1');

    expect(result.node).toMatchObject({ parentId: null, name: 'report.pdf' });
    expect(state.uploadCalls[0]).toMatchObject({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      bytes: PDF.length,
      context: { target: { parentFolderId: PHYSICAL_PARENT } },
    });
    expect(state.prisma.file.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        backingType: FileBackingType.GOOGLE_DRIVE,
      }),
    });
    expect(state.prisma.fileVersion.create).not.toHaveBeenCalled();
    expect(state.prisma.editorSession.create).not.toHaveBeenCalled();
    expect(state.prisma.fileProcessingTask.create).not.toHaveBeenCalled();
    expect(state.auditRows[0]).toMatchObject({
      action: 'GOOGLE_DRIVE_FILE_UPLOADED',
      result: AuditResult.SUCCESS,
    });
  });

  it('places nested uploads in the Docs Hub parent while keeping the configured Drive target', async () => {
    const state = harness({ role: 'DOCUMENT_MANAGER' });
    const result = await upload(
      state,
      'nested-upload-1',
      multipartRequest(PDF, state.folderId),
    );

    expect(result.node.parentId).toBe(state.folderId);
    expect(state.uploadCalls[0]?.context.target.parentFolderId).toBe(
      PHYSICAL_PARENT,
    );
    expect(state.uploadCalls[0]?.context.target.parentFolderId).not.toBe(
      state.folderId,
    );
  });

  it('allows DOCUMENT_MANAGER to upload DOCX as its original binary MIME type', async () => {
    const state = harness({ role: 'DOCUMENT_MANAGER' });
    const result = await upload(
      state,
      'manager-docx-upload',
      multipartRequest(DOCX, null, 'forecast.docx', DOCX_MIME),
    );

    expect(result.node.name).toBe('forecast.docx');
    expect(state.uploadCalls[0]).toMatchObject({
      name: 'forecast.docx',
      mimeType: DOCX_MIME,
      bytes: DOCX.length,
    });
  });

  it('denies VIEWER without creating an operation or falling back to local storage', async () => {
    const state = harness({ role: 'VIEWER' });
    await expect(upload(state, 'viewer-upload')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(state.prisma.driveUploadOperation.create).not.toHaveBeenCalled();
    expect(state.drive.uploadBinaryWithContext).not.toHaveBeenCalled();
    expect(state.prisma.fileVersion.create).not.toHaveBeenCalled();
  });

  it('returns a typed write-authorization error for a metadata-only Drive connection', async () => {
    const state = harness({ writeAuthorized: false });
    await expect(upload(state, 'read-only-upload')).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'GOOGLE_DRIVE_WRITE_AUTHORIZATION_REQUIRED',
      }),
    });
    expect(state.prisma.driveUploadOperation.create).not.toHaveBeenCalled();
    expect(state.drive.uploadBinaryWithContext).not.toHaveBeenCalled();
  });

  it('returns the existing result on an identical idempotent replay without uploading twice', async () => {
    const state = harness();
    const first = await upload(state, 'same-upload-key');
    const replay = await upload(state, 'same-upload-key');

    expect(replay).toEqual(first);
    expect(state.drive.uploadBinaryWithContext).toHaveBeenCalledTimes(1);
    expect(state.prisma.node.create).toHaveBeenCalledTimes(1);
    expect([...state.operations.values()][0]?.status).toBe(
      DriveUploadOperationStatus.SUCCEEDED,
    );
  });

  it('allocates a separate suffixed logical and physical filename for a different key', async () => {
    const state = harness();
    await upload(state, 'upload-key-a');
    const next = await upload(state, 'upload-key-b');

    expect(next.node.name).toBe('report (1).pdf');
    expect(state.uploadCalls.map((call) => call.name)).toEqual([
      'report.pdf',
      'report (1).pdf',
    ]);
  });

  it('does not create Docs Hub rows when Google Drive fails', async () => {
    const state = harness();
    state.drive.uploadBinaryWithContext.mockRejectedValueOnce(
      new DriveProviderError('provider', 503),
    );
    await expect(upload(state, 'upstream-failure')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(state.prisma.node.create).not.toHaveBeenCalled();
    expect(state.prisma.file.create).not.toHaveBeenCalled();
    expect([...state.operations.values()][0]?.status).toBe(
      DriveUploadOperationStatus.FAILED,
    );
  });

  it('compensates a Drive file if database registration fails', async () => {
    const state = harness({ failNodeCreate: true });
    await expect(upload(state, 'db-failure')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(state.drive.deleteBinaryWithContext).toHaveBeenCalledWith(
      state.context,
      'drive-file-1',
    );
    expect([...state.operations.values()][0]?.status).toBe(
      DriveUploadOperationStatus.FAILED,
    );
  });

  it('records reconciliation audit when Drive compensation fails', async () => {
    const state = harness({ failNodeCreate: true, failCompensation: true });
    await expect(upload(state, 'orphaned-upload')).rejects.toThrow(
      'Reconcile Drive file drive-file-1',
    );
    expect(state.auditRows.at(-1)).toMatchObject({
      action: 'GOOGLE_DRIVE_FILE_ORPHANED',
      result: AuditResult.FAILED,
    });
  });

  it('enforces the configured size limit while receiving the stream', async () => {
    const state = harness({ maxBytes: 8 });
    const oversizedPdf = Buffer.concat([PDF, Buffer.alloc(10)]);
    await expect(
      upload(state, 'oversized-upload', multipartRequest(oversizedPdf)),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(state.drive.uploadBinaryWithContext).toHaveBeenCalledTimes(1);
    expect(state.prisma.node.create).not.toHaveBeenCalled();
    expect(state.drive.deleteBinaryWithContext).not.toHaveBeenCalled();
  });

  it('rejects a same-key replay with different bytes', async () => {
    const state = harness();
    await upload(state, 'same-key-different-bytes');
    const modified = Buffer.from('%PDF-1.7\nDifferent body\n');
    await expect(
      upload(state, 'same-key-different-bytes', multipartRequest(modified)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(state.drive.uploadBinaryWithContext).toHaveBeenCalledTimes(1);
  });
});
