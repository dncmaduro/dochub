import type { StorageObjectRef, StorageProvider } from '../../storage/storage-provider.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { TEXT_LIMITS } from './text-limits.js';
import type { TextFileFormat, TextFileModel, TextLineEnding } from './text-model.js';

export class TextSourceError extends Error {
  readonly expected = true;
  constructor(message: string) {
    super(message);
    this.name = 'TextSourceError';
  }
}

export class TextValidationError extends Error {
  readonly expected = true;
  constructor(message: string) {
    super(message);
    this.name = 'TextValidationError';
  }
}

export interface DecodedTextSource {
  content: string;
  bom: boolean;
  lineEnding: TextLineEnding;
  byteLength: number;
}

function lineEndingOf(content: string): TextLineEnding {
  const crlf = (content.match(/\r\n/gu) ?? []).length;
  const withoutCrlf = content.replace(/\r\n/gu, '');
  const lf = (withoutCrlf.match(/\n/gu) ?? []).length;
  const cr = (withoutCrlf.match(/\r/gu) ?? []).length;
  if (crlf === 0 && lf === 0 && cr === 0) return 'none';
  if (crlf > 0 && lf === 0 && cr === 0) return 'crlf';
  if (crlf === 0 && lf > 0 && cr === 0) return 'lf';
  return 'mixed';
}

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r\n|\r|\n/gu).length;
}

export function decodeUtf8(bytes: Uint8Array): DecodedTextSource {
  if (bytes.byteLength > TEXT_LIMITS.maxInputBytes) throw new TextSourceError('Text file is too large to preview.');
  const bom = bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const payload = bom ? bytes.subarray(3) : bytes;
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new TextSourceError('The text file is not valid UTF-8.');
  }
  if (content.length > TEXT_LIMITS.maxDecodedCharacters) throw new TextSourceError('Text file contains too much text to preview.');
  if (lineCount(content) > TEXT_LIMITS.maxLines) throw new TextSourceError('Text file contains too many lines to preview.');
  return { content, bom, lineEnding: lineEndingOf(content), byteLength: bytes.byteLength };
}

export async function readTextSource(storage: StorageProvider, ref: StorageObjectRef): Promise<DecodedTextSource> {
  const content = await storage.openRead(ref);
  if (content.metadata.sizeBytes !== null && content.metadata.sizeBytes > BigInt(TEXT_LIMITS.maxInputBytes)) {
    content.stream.destroy();
    throw new TextSourceError('Text file is too large to preview.');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of content.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > TEXT_LIMITS.maxInputBytes) throw new TextSourceError('Text file is too large to preview.');
      chunks.push(buffer);
    }
  } finally {
    content.stream.destroy();
    if (content.cleanup) await content.cleanup().catch(() => undefined);
  }
  return decodeUtf8(Buffer.concat(chunks));
}

export function encodeUtf8(source: Pick<DecodedTextSource, 'bom' | 'lineEnding'>, content: string): Buffer {
  if (Buffer.byteLength(content, 'utf8') > TEXT_LIMITS.maxEditableBytes) throw new TextValidationError('Edited text is too large to save.');
  let output = content;
  if (source.lineEnding === 'crlf') output = output.replace(/\r\n/gu, '\n').replace(/\n/gu, '\r\n');
  const encoded = Buffer.from(output, 'utf8');
  return source.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]) : encoded;
}

function balancedJsonShape(source: string): void {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let nodes = 0;
  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
      nodes += 1;
      if (depth > TEXT_LIMITS.maxStructuredDepth || nodes > TEXT_LIMITS.maxStructuredNodes) {
        throw new TextValidationError('Structured text is too deeply nested or contains too many nodes.');
      }
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth < 0) throw new TextValidationError('JSON is not valid.');
    }
  }
  if (inString || depth !== 0) throw new TextValidationError('JSON is not valid.');
}

function jsonPreview(content: string): { previewContent: string; parseError: string | null } {
  try {
    balancedJsonShape(content);
    const value: unknown = JSON.parse(content);
    const previewContent = JSON.stringify(value, null, 2);
    return { previewContent: previewContent ?? 'null', parseError: null };
  } catch (error) {
    return { previewContent: content, parseError: error instanceof TextValidationError && error.message.includes('deeply')
      ? 'Structured text is too deeply nested or contains too many nodes.'
      : 'JSON is not valid.' };
  }
}

function xmlDepthCheck(content: string): void {
  if (/<!doctype\b/iu.test(content)) throw new TextValidationError('DOCTYPE and external entities are not supported.');
  const tags = content.match(/<\/?[A-Za-z_][\w:.-]*(?:\s[^<>]*?)?\s*\/?>/gu) ?? [];
  let depth = 0;
  let nodes = 0;
  for (const tag of tags) {
    if (tag.startsWith('</')) depth -= 1;
    else if (!/\/\s*>$/u.test(tag)) {
      depth += 1;
      nodes += 1;
    }
    if (depth > TEXT_LIMITS.maxStructuredDepth || nodes > TEXT_LIMITS.maxStructuredNodes) {
      throw new TextValidationError('Structured text is too deeply nested or contains too many nodes.');
    }
    if (depth < 0) throw new TextValidationError('XML is not well-formed.');
  }
}

export function validateXml(content: string): void {
  xmlDepthCheck(content);
  const validation = XMLValidator.validate(content);
  if (validation !== true) throw new TextValidationError('XML is not well-formed.');
  try {
    new XMLParser({
      allowBooleanAttributes: true,
      ignoreAttributes: false,
      processEntities: false,
      preserveOrder: true,
      trimValues: false,
    }).parse(content);
  } catch {
    throw new TextValidationError('XML is not well-formed.');
  }
}

export function formatXmlForPreview(content: string): string {
  return content
    .replace(/>\s*</gu, '>\n<')
    .split('\n')
    .reduce<string[]>((lines, line) => {
      const trimmed = line.trim();
      if (!trimmed) return lines;
      const closing = trimmed.startsWith('</');
      if (closing) lines.push(trimmed);
      else lines.push(trimmed);
      return lines;
    }, [])
    .join('\n');
}

export function structuredPreview(format: TextFileFormat, content: string): Pick<TextFileModel, 'previewContent' | 'parseError'> {
  if (format === 'json') return jsonPreview(content);
  if (format === 'xml') {
    try {
      validateXml(content);
      return { previewContent: formatXmlForPreview(content), parseError: null };
    } catch (error) {
      return { previewContent: content, parseError: error instanceof TextValidationError && error.message.includes('DOCTYPE')
        ? 'DOCTYPE and external entities are not supported.'
        : error instanceof TextValidationError && error.message.includes('deeply')
          ? 'Structured text is too deeply nested or contains too many nodes.'
          : 'XML is not well-formed.' };
    }
  }
  return { previewContent: content, parseError: null };
}

export function buildTextModel(
  format: TextFileFormat,
  source: DecodedTextSource,
  editable: boolean,
  storageRevision?: string,
): TextFileModel {
  const preview = structuredPreview(format, source.content);
  return {
    version: 1,
    format,
    content: source.content,
    ...preview,
    encoding: 'utf-8',
    bom: source.bom,
    lineEnding: source.lineEnding,
    editable,
    ...(editable ? {} : { readOnlyReason: 'This text file exceeds the native edit limit.' }),
    ...(storageRevision ? { storageRevision } : {}),
  };
}
