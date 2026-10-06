import { fileTypeFromBuffer } from 'file-type';
import { describe, expect, it } from 'vitest';
import {
  OfficeFileKind,
  OfficeLocale,
  OfficeTemplateService,
} from './office-template.service.js';

describe('OfficeTemplateService', () => {
  const service = new OfficeTemplateService();

  it.each([
    [
      OfficeFileKind.DOCX,
      'docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    [
      OfficeFileKind.XLSX,
      'xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    [
      OfficeFileKind.PPTX,
      'pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  ] as const)(
    'provides a valid minimal %s package',
    async (kind, extension, mimeType) => {
      const result = await service.read(kind);
      expect(result.bytes.subarray(0, 4)).toEqual(Buffer.from('PK\x03\x04'));
      await expect(fileTypeFromBuffer(result.bytes)).resolves.toMatchObject({
        ext: extension,
        mime: mimeType,
      });
    },
  );

  it('localizes the default filename without changing the trusted package', async () => {
    await expect(
      service.read(OfficeFileKind.DOCX, OfficeLocale.VI),
    ).resolves.toMatchObject({
      template: { filename: 'Tài liệu chưa đặt tên.docx' },
    });
    await expect(
      service.read(OfficeFileKind.XLSX, OfficeLocale.VI),
    ).resolves.toMatchObject({
      template: { filename: 'Bảng tính chưa đặt tên.xlsx' },
    });
    await expect(
      service.read(OfficeFileKind.PPTX, OfficeLocale.VI),
    ).resolves.toMatchObject({
      template: { filename: 'Bản trình bày chưa đặt tên.pptx' },
    });
  });
});
