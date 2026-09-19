import { open } from 'node:fs/promises';
import path from 'node:path';
import {
  Injectable,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { fileTypeFromFile } from 'file-type';
import { normalizeNodeName } from '../nodes/node-name.js';
import type { TempUpload, ValidatedUpload } from './file-upload.types.js';

const OLE_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);
const ZIP_MIME = 'application/zip';
const GENERIC_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
]);

interface SupportedType {
  mimeType: string;
  declaredMimeTypes: readonly string[];
  kind: 'signature' | 'ole' | 'ooxml';
  ooxmlMarker?: string;
}

const SUPPORTED_TYPES: Readonly<Record<string, SupportedType>> = {
  pdf: {
    mimeType: 'application/pdf',
    declaredMimeTypes: ['application/pdf'],
    kind: 'signature',
  },
  doc: {
    mimeType: 'application/msword',
    declaredMimeTypes: ['application/msword', 'application/x-ole-storage'],
    kind: 'ole',
  },
  docx: {
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    declaredMimeTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    kind: 'ooxml',
    ooxmlMarker: 'word/',
  },
  xls: {
    mimeType: 'application/vnd.ms-excel',
    declaredMimeTypes: ['application/vnd.ms-excel', 'application/x-ole-storage'],
    kind: 'ole',
  },
  xlsx: {
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    declaredMimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    kind: 'ooxml',
    ooxmlMarker: 'xl/',
  },
  ppt: {
    mimeType: 'application/vnd.ms-powerpoint',
    declaredMimeTypes: [
      'application/vnd.ms-powerpoint',
      'application/x-ole-storage',
    ],
    kind: 'ole',
  },
  pptx: {
    mimeType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    declaredMimeTypes: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    kind: 'ooxml',
    ooxmlMarker: 'ppt/',
  },
  jpg: {
    mimeType: 'image/jpeg',
    declaredMimeTypes: ['image/jpeg', 'image/jpg'],
    kind: 'signature',
  },
  jpeg: {
    mimeType: 'image/jpeg',
    declaredMimeTypes: ['image/jpeg', 'image/jpg'],
    kind: 'signature',
  },
  png: { mimeType: 'image/png', declaredMimeTypes: ['image/png'], kind: 'signature' },
  webp: {
    mimeType: 'image/webp',
    declaredMimeTypes: ['image/webp'],
    kind: 'signature',
  },
  gif: { mimeType: 'image/gif', declaredMimeTypes: ['image/gif'], kind: 'signature' },
  mp4: { mimeType: 'video/mp4', declaredMimeTypes: ['video/mp4'], kind: 'signature' },
  webm: {
    mimeType: 'video/webm',
    declaredMimeTypes: ['video/webm'],
    kind: 'signature',
  },
  mov: {
    mimeType: 'video/quicktime',
    declaredMimeTypes: ['video/quicktime'],
    kind: 'signature',
  },
};

@Injectable()
export class FileValidationService {
  async validate(upload: TempUpload): Promise<ValidatedUpload> {
    const originalFilename = this.cleanedFilename(upload.originalFilename);
    const extension = path.extname(originalFilename).slice(1).toLowerCase();
    const supported = SUPPORTED_TYPES[extension];
    if (!supported) {
      throw new UnsupportedMediaTypeException('Unsupported file type');
    }
    this.assertDeclaredMimeType(upload.declaredMimeType, supported);

    const detected = await fileTypeFromFile(upload.tempPath).catch(() => undefined);
    if (supported.kind === 'ole') {
      if (!(await this.hasOleSignature(upload.tempPath))) {
        throw new UnsupportedMediaTypeException('File signature does not match extension');
      }
    } else if (supported.kind === 'ooxml') {
      if (
        !this.isOoxmlDetectorCompatible(detected?.mime, supported.mimeType) ||
        !(await this.hasOoxmlMarkers(upload.tempPath, supported.ooxmlMarker!))
      ) {
        throw new UnsupportedMediaTypeException('Invalid Office document package');
      }
    } else if (
      !(await this.signatureMatches(
        supported.mimeType,
        detected?.mime,
        upload.tempPath,
      ))
    ) {
      throw new UnsupportedMediaTypeException('File signature does not match extension');
    }

    const nodeName = normalizeNodeName(originalFilename);
    return {
      originalFilename,
      nodeName: nodeName.name,
      normalizedNodeName: nodeName.normalizedName,
      extension,
      mimeType: supported.mimeType,
      sizeBytes: upload.sizeBytes,
      sha256: upload.sha256,
    };
  }

  private cleanedFilename(value: string): string {
    // Client-supplied paths are metadata only; retain the final logical segment.
    const filename = value.split(/[\\/]/).at(-1) ?? '';
    return filename.trim().normalize('NFC');
  }

  private assertDeclaredMimeType(
    declared: string,
    supported: SupportedType,
  ): void {
    const normalized = declared.split(';', 1)[0].trim().toLowerCase();
    if (
      !GENERIC_MIME_TYPES.has(normalized) &&
      !supported.declaredMimeTypes.includes(normalized)
    ) {
      throw new UnsupportedMediaTypeException('Declared MIME type does not match extension');
    }
  }

  private async signatureMatches(
    expectedMime: string,
    detectedMime: string | undefined,
    tempPath: string,
  ): Promise<boolean> {
    if (detectedMime === expectedMime) {
      return true;
    }
    // file-type intentionally reports some small PDFs as undefined; the PDF
    // header is a bounded, unambiguous fallback.
    return expectedMime === 'application/pdf' && (await this.hasPdfHeader(tempPath));
  }

  private async hasPdfHeader(tempPath: string): Promise<boolean> {
    const handle = await open(tempPath, 'r');
    try {
      const header = Buffer.alloc(5);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return bytesRead === header.length && header.equals(Buffer.from('%PDF-'));
    } finally {
      await handle.close();
    }
  }

  private async hasOleSignature(tempPath: string): Promise<boolean> {
    const handle = await open(tempPath, 'r');
    try {
      const header = Buffer.alloc(OLE_SIGNATURE.length);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return bytesRead === header.length && header.equals(OLE_SIGNATURE);
    } finally {
      await handle.close();
    }
  }

  private isOoxmlDetectorCompatible(
    detectedMime: string | undefined,
    expectedMime: string,
  ): boolean {
    return (
      detectedMime === undefined ||
      detectedMime === ZIP_MIME ||
      detectedMime === expectedMime
    );
  }

  /**
   * ZIP central directories are at the end of an archive. Inspecting at most
   * one MiB there is bounded and prevents accepting arbitrary ZIP renames.
   */
  private async hasOoxmlMarkers(
    tempPath: string,
    expectedMarker: string,
  ): Promise<boolean> {
    const handle = await open(tempPath, 'r');
    try {
      const { size } = await handle.stat();
      const bytesToRead = Math.min(size, 1024 * 1024);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        bytesToRead,
        Math.max(0, size - bytesToRead),
      );
      const inspection = buffer.subarray(0, bytesRead).toString('latin1');
      return (
        inspection.includes('[Content_Types].xml') &&
        inspection.includes(expectedMarker)
      );
    } finally {
      await handle.close();
    }
  }
}
