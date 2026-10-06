import { readFile } from 'node:fs/promises';
import { Injectable, UnprocessableEntityException } from '@nestjs/common';

export enum OfficeFileKind {
  DOCX = 'DOCX',
  XLSX = 'XLSX',
  PPTX = 'PPTX',
}

export enum OfficeLocale {
  EN = 'en',
  VI = 'vi',
}

export interface OfficeTemplate {
  kind: OfficeFileKind;
  filename: string;
  extension: string;
  mimeType: string;
  resource: string;
}

const TEMPLATES: Readonly<
  Record<
    OfficeFileKind,
    Omit<OfficeTemplate, 'filename'> & {
      filenames: Record<OfficeLocale, string>;
    }
  >
> = {
  [OfficeFileKind.DOCX]: {
    kind: OfficeFileKind.DOCX,
    filenames: {
      [OfficeLocale.EN]: 'Untitled document.docx',
      [OfficeLocale.VI]: 'Tài liệu chưa đặt tên.docx',
    },
    extension: 'docx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    resource: './templates/blank.docx',
  },
  [OfficeFileKind.XLSX]: {
    kind: OfficeFileKind.XLSX,
    filenames: {
      [OfficeLocale.EN]: 'Untitled spreadsheet.xlsx',
      [OfficeLocale.VI]: 'Bảng tính chưa đặt tên.xlsx',
    },
    extension: 'xlsx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    resource: './templates/blank.xlsx',
  },
  [OfficeFileKind.PPTX]: {
    kind: OfficeFileKind.PPTX,
    filenames: {
      [OfficeLocale.EN]: 'Untitled presentation.pptx',
      [OfficeLocale.VI]: 'Bản trình bày chưa đặt tên.pptx',
    },
    extension: 'pptx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    resource: './templates/blank.pptx',
  },
};

@Injectable()
export class OfficeTemplateService {
  get(kind: OfficeFileKind, locale = OfficeLocale.EN): OfficeTemplate {
    const template = TEMPLATES[kind];
    if (!template) {
      throw new UnprocessableEntityException('Unsupported Office file kind');
    }
    return {
      ...template,
      filename:
        template.filenames[locale] ?? template.filenames[OfficeLocale.EN],
    };
  }

  async read(
    kind: OfficeFileKind,
    locale = OfficeLocale.EN,
  ): Promise<{
    template: OfficeTemplate;
    bytes: Buffer;
  }> {
    const template = this.get(kind, locale);
    const bytes = await readFile(new URL(template.resource, import.meta.url));
    if (bytes.length === 0) {
      throw new Error(`Office template ${kind} is empty`);
    }
    return { template, bytes };
  }
}
