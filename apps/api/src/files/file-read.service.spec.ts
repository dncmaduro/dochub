import { Readable, Writable } from 'node:stream';
import { NotFoundException } from '@nestjs/common';
import { NodeType } from '@dochub/database';
import { describe, expect, it, vi } from 'vitest';
import { DocumentCapability } from '../authorization/document-capability.js';
import { FilesController } from './files.controller.js';
import { FileReadService } from './file-read.service.js';

describe('binary read authorization and stream lifecycle', () => {
  it('does not touch storage when the node is invisible', async () => {
    const storage = { stat: vi.fn(), openReadStream: vi.fn() };
    const database = {
      prisma: {
        node: {
          findFirst: vi
            .fn()
            .mockResolvedValue({
              id: 'node',
              type: NodeType.FILE,
              file: { id: 'file', currentVersionId: 'version' },
            }),
        },
      },
    };
    const authorization = {
      resolveCapabilities: vi
        .fn()
        .mockResolvedValue({ capabilities: new Set() }),
    };
    const service = new FileReadService(
      database as never,
      authorization as never,
      storage as never,
    );
    await expect(
      service.open('user', 'node', DocumentCapability.PREVIEW, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.stat).not.toHaveBeenCalled();
    expect(storage.openReadStream).not.toHaveBeenCalled();
  });

  it('uses PREVIEW for content, DOWNLOAD for download, and destroys stream on response close', async () => {
    const stream = new Readable({ read() {} });
    const reads = {
      open: vi
        .fn()
        .mockResolvedValue({
          stream,
          version: {
            mimeType: 'application/pdf',
            originalFilename: 'x.pdf',
            sizeBytes: 1n,
          },
          totalSize: 1n,
          range: null,
        }),
      write: vi.fn((binary, response) =>
        response.once('close', () => binary.stream.destroy()),
      ),
    };
    const response = Object.assign(
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      {
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
        headersSent: false,
        destroy: vi.fn(),
        end: vi.fn(),
      },
    ) as never;
    const request = { header: vi.fn() } as never;
    const controller = new FilesController(
      {} as never,
      reads as never,
      {} as never,
    );
    await controller.currentContent(
      { userId: 'u', sessionId: 's' },
      'n',
      request,
      response,
    );
    expect(reads.open).toHaveBeenLastCalledWith(
      'u',
      'n',
      DocumentCapability.PREVIEW,
      undefined,
      undefined,
    );
    response.emit('close');
    expect(stream.destroyed).toBe(true);
    const second = Object.assign(
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      {
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
        headersSent: false,
        destroy: vi.fn(),
        end: vi.fn(),
      },
    ) as never;
    await controller.currentDownload(
      { userId: 'u', sessionId: 's' },
      'n',
      request,
      second,
    );
    expect(reads.open).toHaveBeenLastCalledWith(
      'u',
      'n',
      DocumentCapability.DOWNLOAD,
      undefined,
      undefined,
    );
  });

  it('uses safe attachment headers for an unknown binary download', async () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const stream = Readable.from([bytes]);
    const database = { prisma: {} };
    const service = new FileReadService(
      database as never,
      {} as never,
      {} as never,
    );
    const response = Object.assign(
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      {
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn(),
        headersSent: false,
        destroy: vi.fn(),
      },
    );
    const finished = new Promise<void>((resolve) => response.once('finish', resolve));

    service.write(
      {
        stream,
        version: {
          originalFilename: 'archive.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: BigInt(bytes.length),
        },
        totalSize: BigInt(bytes.length),
        range: null,
      },
      response as never,
      true,
    );
    await finished;

    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/octet-stream',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Content-Type-Options',
      'nosniff',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringContaining('attachment'),
    );
  });
});
