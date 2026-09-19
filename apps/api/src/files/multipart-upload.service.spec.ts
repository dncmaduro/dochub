import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MultipartUploadService } from './multipart-upload.service.js';

const directories: string[] = [];

function multipartRequest(parts: Buffer[]): PassThrough & { headers: Record<string, string> } {
  const request = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
  };
  request.headers = {
    'content-type': 'multipart/form-data; boundary=dochub-test-boundary',
  };
  queueMicrotask(() => {
    for (const part of parts) {
      request.write(part);
    }
    request.end();
  });
  return request;
}

function filePart(filename: string, contents: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      '--dochub-test-boundary\r\nContent-Disposition: form-data; name="file"; filename="' +
        filename +
        '"\r\nContent-Type: application/pdf\r\n\r\n',
    ),
    contents,
    Buffer.from('\r\n'),
  ]);
}

const closing = Buffer.from('--dochub-test-boundary--\r\n');

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('MultipartUploadService', () => {
  async function service(maxBytes = 1024) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dochub-multipart-'));
    directories.push(root);
    return {
      root,
      service: new MultipartUploadService({
        driver: 'local',
        root,
        uploadTempRoot: root,
        uploadMaxBytes: maxBytes,
      }),
    };
  }

  it('streams a single file to a random temp name while hashing and counting bytes', async () => {
    const { root, service: parser } = await service();
    const bytes = Buffer.from('%PDF-1.7\nstreamed');
    const upload = await parser.receive(
      multipartRequest([
        Buffer.from(
          '--dochub-test-boundary\r\nContent-Disposition: form-data; name="parentId"\r\n\r\n\r\n',
        ),
        filePart('C:\\fakepath\\report.pdf', bytes),
        closing,
      ]) as never,
    );
    expect(path.basename(upload.tempPath)).not.toContain('report');
    expect(upload.sizeBytes).toBe(BigInt(bytes.length));
    expect(upload.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await stat(upload.tempPath)).toMatchObject({ size: bytes.length });
    await parser.cleanup(upload.tempPath);
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects missing, multiple, and oversized files and cleans temporary state', async () => {
    const { root, service: parser } = await service(8);
    await expect(
      parser.receive(
        multipartRequest([closing]) as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      parser.receive(
        multipartRequest([
          filePart('one.pdf', Buffer.from('123')),
          filePart('two.pdf', Buffer.from('456')),
          closing,
        ]) as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      parser.receive(
        multipartRequest([filePart('large.pdf', Buffer.alloc(9)), closing]) as never,
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(await readdir(root)).toEqual([]);
  });
});
