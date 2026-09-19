import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileValidationService } from './file-validation.service.js';

const directories: string[] = [];

async function temporaryUpload(
  filename: string,
  contents: Buffer,
  declaredMimeType = 'application/octet-stream',
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dochub-validation-'));
  directories.push(directory);
  const tempPath = path.join(directory, 'upload');
  await writeFile(tempPath, contents);
  return {
    tempPath,
    originalFilename: filename,
    declaredMimeType,
    parentId: null,
    sizeBytes: BigInt(contents.length),
    sha256: 'a'.repeat(64),
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('FileValidationService', () => {
  const service = new FileValidationService();

  it('normalizes a client path and accepts a valid PDF from a bounded signature check', async () => {
    const upload = await temporaryUpload(
      'C:\\fakepath\\Report.PDF',
      Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'),
      'application/pdf',
    );
    await expect(service.validate(upload)).resolves.toMatchObject({
      originalFilename: 'Report.PDF',
      nodeName: 'Report.PDF',
      extension: 'pdf',
      mimeType: 'application/pdf',
    });
  });

  it('rejects extension/signature mismatch, unsupported types, and arbitrary ZIP renames', async () => {
    await expect(
      service.validate(
        await temporaryUpload('image.png', Buffer.from('%PDF-1.7\n')),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      service.validate(
        await temporaryUpload('unsafe.exe', Buffer.from('MZ fake executable')),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      service.validate(
        await temporaryUpload(
          'not-a-document.docx',
          Buffer.from('PK\x03\x04ordinary zip without OOXML markers'),
        ),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('requires the OLE Compound File signature for legacy Office extensions', async () => {
    await expect(
      service.validate(
        await temporaryUpload('legacy.doc', Buffer.from('not an OLE file')),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });
});
