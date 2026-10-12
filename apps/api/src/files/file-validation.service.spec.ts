import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { FileValidationService } from './file-validation.service.js';

const directories: string[] = [];
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

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
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
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

  it('rejects known binary signature mismatches but accepts unknown extensions', async () => {
    await expect(
      service.validate(
        await temporaryUpload('image.png', Buffer.from('%PDF-1.7\n')),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      service.validate(
        await temporaryUpload('unsafe.exe', Buffer.from('MZ fake executable')),
      ),
    ).resolves.toMatchObject({
      extension: 'exe',
      mimeType: 'application/octet-stream',
    });
    await expect(
      service.validate(
        await temporaryUpload(
          'not-a-document.docx',
          Buffer.from('PK\x03\x04ordinary zip without OOXML markers'),
        ),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });

  it.each([
    ['test.txt', 'text/plain', Buffer.from('plain text')],
    ['test.md', 'text/markdown', Buffer.from('# Markdown')],
    ['test.json', 'text/json', Buffer.from('{ malformed but stored }')],
    ['test.xml', 'text/xml', Buffer.from('<not-well-formed')],
    ['test.csv', 'application/csv', Buffer.from('name,value\nAda,1\n')],
    [
      'test.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      Buffer.from('PK\x03\x04 [Content_Types].xml word/document.xml'),
    ],
    [
      'test.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.from('PK\x03\x04 [Content_Types].xml xl/workbook.xml'),
    ],
    [
      'test.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      Buffer.from('PK\x03\x04 [Content_Types].xml ppt/presentation.xml'),
    ],
    ['test.pdf', 'application/pdf', Buffer.from('%PDF-1.7\n')],
    ['test.png', 'image/png', PNG],
    ['test.bin', 'application/octet-stream', Buffer.from([0, 1, 2, 3])],
    ['empty-mime.bin', '', Buffer.from([4, 5, 6])],
  ])('accepts the generic repository fixture %s', async (filename, mime, contents) => {
    await expect(
      service.validate(await temporaryUpload(filename, contents, mime)),
    ).resolves.toMatchObject({
      originalFilename: filename,
      extension: filename.split('.').at(-1),
      mimeType:
        mime === 'text/json'
          ? 'application/json'
          : mime === 'application/csv'
            ? 'text/csv'
            : mime || 'application/octet-stream',
    });
  });

  it('accepts an Excel-reported CSV without reclassifying it as CSV metadata', async () => {
    await expect(
      service.validate(
        await temporaryUpload(
          'reported-as-excel.csv',
          Buffer.from('name,value\nAda,1\n'),
          'application/vnd.ms-excel',
        ),
      ),
    ).resolves.toMatchObject({ mimeType: 'application/vnd.ms-excel' });
  });

  it('keeps oversized streams rejected independently of file type', async () => {
    const validation = service.beginStreamingValidation(
      'unknown.bin',
      '',
      3,
    );
    await expect(
      (async () => {
        for await (const _chunk of Readable.from([Buffer.from('1234')]).pipe(validation.stream)) {
          // Consume the stream to surface the transform error.
        }
      })(),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('requires the OLE Compound File signature for legacy Office extensions', async () => {
    await expect(
      service.validate(
        await temporaryUpload('legacy.doc', Buffer.from('not an OLE file')),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('keeps a client path out of metadata and rejects control characters and oversized names', async () => {
    await expect(
      service.validate(
        await temporaryUpload('../../secret.pdf', Buffer.from('%PDF-1.7\n')),
      ),
    ).resolves.toMatchObject({ originalFilename: 'secret.pdf' });
    await expect(
      service.validate(
        await temporaryUpload('line\nbreak.pdf', Buffer.from('%PDF-1.7\n')),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.validate(
        await temporaryUpload(
          `${'a'.repeat(256)}.pdf`,
          Buffer.from('%PDF-1.7\n'),
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
