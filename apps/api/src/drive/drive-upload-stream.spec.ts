import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DriveUploadValidationTransform } from './drive-upload-stream.js';

async function validate(
  filename: string,
  mimeType: string,
  contents: Buffer,
  maxBytes = 1024,
) {
  const validator = new DriveUploadValidationTransform({
    filename,
    declaredMimeType: mimeType,
    expectedSize: BigInt(contents.length),
    maxBytes,
  });
  for await (const _chunk of Readable.from([contents]).pipe(validator)) {
    // Consume the bounded stream just as the Drive provider does.
  }
  return validator.metadata();
}

describe('DriveUploadValidationTransform', () => {
  it('validates PDF signature while streaming and computes SHA-256', async () => {
    const contents = Buffer.from('%PDF-1.7\nsmall file');
    await expect(validate('report.pdf', 'application/pdf', contents)).resolves.toMatchObject({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: BigInt(contents.length),
      sha256: createHash('sha256').update(contents).digest('hex'),
    });
  });

  it('rejects a mismatched extension, declared MIME, actual signature, and oversized stream', async () => {
    await expect(validate('report.exe', 'application/pdf', Buffer.from('%PDF-1.7')))
      .rejects.toMatchObject({ status: 415 });
    await expect(validate('report.pdf', 'image/png', Buffer.from('%PDF-1.7')))
      .rejects.toMatchObject({ status: 415 });
    await expect(validate('image.png', 'image/png', Buffer.from('%PDF-1.7')))
      .rejects.toMatchObject({ status: 415 });
    await expect(validate('report.pdf', 'application/pdf', Buffer.alloc(9, 0x25), 8))
      .rejects.toMatchObject({ status: 413 });
  });

  it('rejects a request whose declared size differs from the streamed size', async () => {
    const validator = new DriveUploadValidationTransform({
      filename: 'report.pdf',
      declaredMimeType: 'application/pdf',
      expectedSize: 20n,
      maxBytes: 1024,
    });
    await expect(async () => {
      for await (const _chunk of Readable.from([Buffer.from('%PDF-1.7')]).pipe(validator)) {
        // Consume the stream.
      }
    }).rejects.toMatchObject({ status: 400 });
  });
});
