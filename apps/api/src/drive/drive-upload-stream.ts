import { createHash } from 'node:crypto';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { fileTypeFromBuffer } from 'file-type';
import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { normalizeNodeName } from '../nodes/node-name.js';

const PREFIX_BYTES = 4100;
const TAIL_BYTES = 1024 * 1024;
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

interface SupportedUploadType {
  mimeType: string;
  declaredMimeTypes: readonly string[];
  kind: 'signature' | 'ole' | 'ooxml';
  marker?: string;
}

const SUPPORTED_TYPES: Readonly<Record<string, SupportedUploadType>> = {
  pdf: { mimeType: 'application/pdf', declaredMimeTypes: ['application/pdf'], kind: 'signature' },
  doc: { mimeType: 'application/msword', declaredMimeTypes: ['application/msword', 'application/x-ole-storage'], kind: 'ole' },
  docx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    declaredMimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    kind: 'ooxml', marker: 'word/',
  },
  xls: { mimeType: 'application/vnd.ms-excel', declaredMimeTypes: ['application/vnd.ms-excel', 'application/x-ole-storage'], kind: 'ole' },
  xlsx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    declaredMimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    kind: 'ooxml', marker: 'xl/',
  },
  ppt: { mimeType: 'application/vnd.ms-powerpoint', declaredMimeTypes: ['application/vnd.ms-powerpoint', 'application/x-ole-storage'], kind: 'ole' },
  pptx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    declaredMimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    kind: 'ooxml', marker: 'ppt/',
  },
  jpg: { mimeType: 'image/jpeg', declaredMimeTypes: ['image/jpeg', 'image/jpg'], kind: 'signature' },
  jpeg: { mimeType: 'image/jpeg', declaredMimeTypes: ['image/jpeg', 'image/jpg'], kind: 'signature' },
  png: { mimeType: 'image/png', declaredMimeTypes: ['image/png'], kind: 'signature' },
  webp: { mimeType: 'image/webp', declaredMimeTypes: ['image/webp'], kind: 'signature' },
  gif: { mimeType: 'image/gif', declaredMimeTypes: ['image/gif'], kind: 'signature' },
  mp4: { mimeType: 'video/mp4', declaredMimeTypes: ['video/mp4'], kind: 'signature' },
  webm: { mimeType: 'video/webm', declaredMimeTypes: ['video/webm'], kind: 'signature' },
  mov: { mimeType: 'video/quicktime', declaredMimeTypes: ['video/quicktime'], kind: 'signature' },
};

export interface DriveUploadMetadata {
  name: string;
  mimeType: string;
  extension: string;
  sizeBytes: bigint;
  sha256: string;
}

/** Counts and validates one request stream without staging bytes on local storage. */
export class DriveUploadValidationTransform extends Transform {
  readonly name: string;
  readonly mimeType: string;
  readonly extension: string;

  private readonly supported: SupportedUploadType;
  private readonly expectedSize: bigint;
  private readonly maxBytes: bigint;
  private readonly hash = createHash('sha256');
  private readonly tail = Buffer.alloc(TAIL_BYTES);
  private prefix = Buffer.alloc(0);
  private tailLength = 0;
  private tailPosition = 0;
  private received = 0n;
  private result?: DriveUploadMetadata;
  private magicValidated = false;

  constructor(options: {
    filename: string;
    declaredMimeType: string;
    expectedSize: bigint;
    maxBytes: number;
  }) {
    super();
    const cleanFilename = options.filename.split(/[\\/]/).at(-1)?.trim().normalize('NFC') ?? '';
    const name = normalizeNodeName(cleanFilename);
    const extension = path.extname(name.name).slice(1).toLowerCase();
    const supported = SUPPORTED_TYPES[extension];
    if (!supported) throw new UnsupportedMediaTypeException('Unsupported file type');
    const declared = options.declaredMimeType.split(';', 1)[0].trim().toLowerCase();
    if (!GENERIC_MIME_TYPES.has(declared) && !supported.declaredMimeTypes.includes(declared)) {
      throw new UnsupportedMediaTypeException('Declared MIME type does not match extension');
    }
    if (options.expectedSize <= 0n) throw new BadRequestException('Empty uploads are not supported');
    if (options.expectedSize > BigInt(options.maxBytes)) {
      throw new PayloadTooLargeException('File exceeds upload limit');
    }
    this.name = name.name;
    this.mimeType = supported.mimeType;
    this.extension = extension;
    this.supported = supported;
    this.expectedSize = options.expectedSize;
    this.maxBytes = BigInt(options.maxBytes);
  }

  metadata(): DriveUploadMetadata {
    if (!this.result) throw new BadRequestException('Upload validation is incomplete');
    return this.result;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.received += BigInt(chunk.length);
    if (this.received > this.maxBytes || this.received > this.expectedSize) {
      callback(new PayloadTooLargeException('File exceeds upload limit'));
      return;
    }
    this.hash.update(chunk);
    if (this.prefix.length < PREFIX_BYTES) {
      this.prefix = Buffer.concat([this.prefix, chunk.subarray(0, PREFIX_BYTES - this.prefix.length)]);
      if (this.prefix.length >= PREFIX_BYTES) {
        void this.validateMagic(this.prefix).then(
          () => {
            this.magicValidated = true;
            this.recordTail(chunk);
            callback(null, chunk);
          },
          (error: unknown) => callback(error as Error),
        );
        return;
      }
    }
    this.recordTail(chunk);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    void this.finishValidation().then(
      () => callback(),
      (error: unknown) => callback(error as Error),
    );
  }

  private async finishValidation(): Promise<void> {
    if (this.received !== this.expectedSize) {
      throw new BadRequestException('Upload size did not match the request');
    }
    if (!this.magicValidated) await this.validateMagic(this.prefix);
    if (this.supported.kind === 'ooxml') {
      const archiveEnd = this.readTail().toString('latin1');
      if (!archiveEnd.includes('[Content_Types].xml') || !archiveEnd.includes(this.supported.marker!)) {
        throw new UnsupportedMediaTypeException('Invalid Office document package');
      }
    }
    this.result = {
      name: this.name,
      mimeType: this.mimeType,
      extension: this.extension,
      sizeBytes: this.received,
      sha256: this.hash.digest('hex'),
    };
  }

  private async validateMagic(prefix: Buffer): Promise<void> {
    if (this.supported.kind === 'ole') {
      if (!prefix.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE)) {
        throw new UnsupportedMediaTypeException('File signature does not match extension');
      }
      return;
    }
    if (this.supported.kind === 'ooxml') {
      if (prefix.length < 4 || prefix.subarray(0, 2).toString('ascii') !== 'PK') {
        throw new UnsupportedMediaTypeException('Invalid Office document package');
      }
      return;
    }
    const detectedMime = (await fileTypeFromBuffer(prefix))?.mime;
    const pdfHeader = prefix.subarray(0, 5).toString('ascii') === '%PDF-';
    if (
      detectedMime !== this.supported.mimeType &&
      !(this.supported.mimeType === 'application/pdf' && pdfHeader)
    ) {
      throw new UnsupportedMediaTypeException('File signature does not match extension');
    }
  }

  private recordTail(chunk: Buffer): void {
    if (chunk.length >= TAIL_BYTES) {
      chunk.copy(this.tail, 0, chunk.length - TAIL_BYTES);
      this.tailLength = TAIL_BYTES;
      this.tailPosition = 0;
      return;
    }
    const firstPart = Math.min(chunk.length, TAIL_BYTES - this.tailPosition);
    chunk.copy(this.tail, this.tailPosition, 0, firstPart);
    if (firstPart < chunk.length) chunk.copy(this.tail, 0, firstPart);
    this.tailPosition = (this.tailPosition + chunk.length) % TAIL_BYTES;
    this.tailLength = Math.min(TAIL_BYTES, this.tailLength + chunk.length);
  }

  private readTail(): Buffer {
    if (this.tailLength < TAIL_BYTES) return this.tail.subarray(0, this.tailLength);
    return Buffer.concat([this.tail.subarray(this.tailPosition), this.tail.subarray(0, this.tailPosition)]);
  }
}
