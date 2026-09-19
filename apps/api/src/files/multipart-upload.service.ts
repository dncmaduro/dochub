import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BadRequestException,
  Inject,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import Busboy from 'busboy';
import type { Request } from 'express';
import { STORAGE_CONFIG, type StorageConfig } from '../storage/storage.config.js';
import type { TempUpload } from './file-upload.types.js';

const MAX_MULTIPART_FIELDS = 4;
const MAX_MULTIPART_PARTS = 6;
const MAX_FIELD_BYTES = 4 * 1024;

class UploadAbortedError extends Error {}

@Injectable()
export class MultipartUploadService {
  constructor(
    @Inject(STORAGE_CONFIG) private readonly config: StorageConfig,
  ) {}

  /**
   * Streams exactly one multipart binary into a random, private temporary file.
   * The parser and transform keep memory bounded; only signature inspection later
   * reads a small fixed-size file slice.
   */
  async receive(request: Request): Promise<TempUpload> {
    if (!request.headers['content-type']?.startsWith('multipart/form-data')) {
      throw new BadRequestException('Expected multipart/form-data');
    }
    await mkdir(this.config.uploadTempRoot, {
      recursive: true,
      mode: 0o700,
    });
    const tempPath = path.join(this.config.uploadTempRoot, randomUUID());
    let cleanupRequired = true;
    try {
      const upload = await this.parse(request, tempPath);
      cleanupRequired = false;
      return upload;
    } finally {
      if (cleanupRequired) {
        await this.cleanup(tempPath);
      }
    }
  }

  async cleanup(tempPath: string): Promise<void> {
    await unlink(tempPath).catch((error: unknown) => {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    });
  }

  private parse(request: Request, tempPath: string): Promise<TempUpload> {
    return new Promise((resolve, reject) => {
      let parser: ReturnType<typeof Busboy>;
      try {
        parser = Busboy({
          headers: request.headers,
          limits: {
            files: 2,
            fields: MAX_MULTIPART_FIELDS,
            parts: MAX_MULTIPART_PARTS,
            fieldSize: MAX_FIELD_BYTES,
            // The transform turns byte max + 1 into a stable 413 response.
            fileSize: this.config.uploadMaxBytes + 1,
          },
        });
      } catch {
        reject(new BadRequestException('Malformed multipart request'));
        return;
      }

      let settled = false;
      let fileCount = 0;
      let parentId: string | null = null;
      let parentSeen = false;
      let filePromise: Promise<{
        originalFilename: string;
        declaredMimeType: string;
        sizeBytes: bigint;
        sha256: string;
      }> | null = null;
      let failure: Error | null = null;

      const fail = (error: Error) => {
        if (!failure) {
          failure = error;
        }
      };
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        void (async () => {
          try {
            await filePromise;
            if (failure) {
              throw failure;
            }
            if (fileCount !== 1 || !filePromise) {
              throw new BadRequestException('Exactly one file is required');
            }
            resolve({
              tempPath,
              parentId,
              ...(await filePromise),
            });
          } catch (error) {
            reject(this.uploadError(error));
          }
        })();
      };

      request.once('aborted', () => {
        fail(new UploadAbortedError());
        parser.destroy();
      });
      request.once('error', () => {
        fail(new UploadAbortedError());
        parser.destroy();
      });

      parser.on('field', (name, value, info) => {
        if (
          name !== 'parentId' ||
          info.nameTruncated ||
          info.valueTruncated ||
          parentSeen
        ) {
          fail(new BadRequestException('Invalid multipart fields'));
          return;
        }
        parentSeen = true;
        parentId = value.trim() || null;
      });
      parser.on('filesLimit', () =>
        fail(new BadRequestException('Exactly one file is required')),
      );
      parser.on('fieldsLimit', () =>
        fail(new BadRequestException('Too many multipart fields')),
      );
      parser.on('partsLimit', () =>
        fail(new BadRequestException('Too many multipart parts')),
      );
      parser.on('error', () => fail(new BadRequestException('Malformed multipart request')));
      // Busboy emits close rather than finish after destruction (for example,
      // on a disconnected client). Waiting for the active pipeline first keeps
      // cleanup from racing an open temporary file.
      parser.once('close', () => {
        if (failure) {
          finish();
        }
      });
      parser.on('file', (fieldName, file, info) => {
        fileCount += 1;
        if (fieldName !== 'file' || fileCount !== 1 || !info.filename) {
          fail(new BadRequestException('Exactly one file is required'));
          file.resume();
          return;
        }
        const hash = createHash('sha256');
        let bytes = 0n;
        const counter = new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            bytes += BigInt(chunk.length);
            if (bytes > BigInt(this.config.uploadMaxBytes)) {
              callback(new PayloadTooLargeException('File exceeds upload limit'));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        file.once('limit', () =>
          fail(new PayloadTooLargeException('File exceeds upload limit')),
        );
        filePromise = pipeline(
          file,
          counter,
          createWriteStream(tempPath, {
            flags: 'wx',
            mode: 0o600,
          }),
        ).then(() => ({
          originalFilename: info.filename,
          declaredMimeType: info.mimeType,
          sizeBytes: bytes,
          sha256: hash.digest('hex'),
        }));
        void filePromise.catch((error: unknown) => fail(this.uploadError(error)));
      });
      parser.once('finish', finish);
      request.pipe(parser);
    });
  }

  private uploadError(error: unknown): Error {
    if (
      error instanceof BadRequestException ||
      error instanceof PayloadTooLargeException
    ) {
      return error;
    }
    if (error instanceof UploadAbortedError) {
      return new BadRequestException('Upload was aborted');
    }
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      return new BadRequestException('Unable to create temporary upload');
    }
    return new BadRequestException('Malformed multipart request');
  }
}
