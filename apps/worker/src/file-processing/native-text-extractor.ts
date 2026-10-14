import { unzipSync } from 'fflate';

export class NativeExtractionError extends Error {
  constructor(
    readonly code: 'MALFORMED' | 'LIMIT_EXCEEDED' | 'UNSUPPORTED',
    message: string,
  ) {
    super(message);
    this.name = 'NativeExtractionError';
  }
}

export interface NativeExtractionResult {
  text: string;
  truncated: boolean;
}

const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SHEET_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PRESENTATION_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const CSV_MIMES = new Set(['text/csv', 'application/csv']);
const TEXT_MIMES = new Set([
  'text/plain', 'text/markdown', 'text/x-markdown', 'application/json',
  'text/json', 'application/xml', 'text/xml',
]);

function normalized(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

function extension(name: string) {
  return /\.[a-z0-9]+$/i.exec(name)?.[0]?.toLowerCase() ?? '';
}

function isType(mimeType: string | null | undefined, name: string, values: ReadonlySet<string>, extensions: readonly string[]) {
  const mime = normalized(mimeType);
  return values.has(mime) || ((!mime || mime === 'application/octet-stream') && extensions.includes(extension(name)));
}

export function nativeExtractionSupported(mimeType: string | null | undefined, name: string): boolean {
  const mime = normalized(mimeType);
  return TEXT_MIMES.has(mime) || CSV_MIMES.has(mime)
    || isType(mime, name, new Set([WORD_MIME]), ['.docx'])
    || isType(mime, name, new Set([SHEET_MIME]), ['.xlsx'])
    || isType(mime, name, new Set([PRESENTATION_MIME]), ['.pptx'])
    || ['.txt', '.md', '.markdown', '.json', '.xml', '.csv'].includes(extension(name));
}

export function extractNativeText(
  bytes: Buffer,
  mimeType: string | null | undefined,
  name: string,
  maxChars: number,
): NativeExtractionResult {
  if (bytes.byteLength === 0) return { text: '', truncated: false };
  const mime = normalized(mimeType);
  if (TEXT_MIMES.has(mime) || ['.txt', '.md', '.markdown', '.json', '.xml'].includes(extension(name))) {
    return boundedText(bytes.toString('utf8'), maxChars);
  }
  if (CSV_MIMES.has(mime) || extension(name) === '.csv') {
    return boundedText(extractCsv(bytes.toString('utf8')), maxChars);
  }
  if (mime === WORD_MIME || extension(name) === '.docx') return boundedText(extractDocx(bytes), maxChars);
  if (mime === SHEET_MIME || extension(name) === '.xlsx') return boundedText(extractXlsx(bytes), maxChars);
  if (mime === PRESENTATION_MIME || extension(name) === '.pptx') return boundedText(extractPptx(bytes), maxChars);
  throw new NativeExtractionError('UNSUPPORTED', 'No native text extractor is available');
}

function unzip(bytes: Buffer): Record<string, Uint8Array> {
  try {
    assertZipBounds(bytes);
    const entries = unzipSync(bytes, {
      filter: (file) => /^(word\/document\.xml|xl\/(?:sharedStrings\.xml|workbook\.xml|worksheets\/sheet\d+\.xml)|ppt\/slides\/slide\d+\.xml)$/.test(file.name),
    });
    const total = Object.values(entries).reduce((size, value) => size + value.byteLength, 0);
    if (total > 64 * 1024 * 1024) {
      throw new NativeExtractionError('LIMIT_EXCEEDED', 'Office XML payload exceeds extraction limit');
    }
    return entries;
  } catch (error) {
    if (error instanceof NativeExtractionError) throw error;
    throw new NativeExtractionError('MALFORMED', 'Office package could not be read');
  }
}

/** Reject declared ZIP-bomb sizes before asking an OOXML inflater for bytes. */
function assertZipBounds(bytes: Buffer): void {
  const end = findEndOfCentralDirectory(bytes);
  if (end < 0 || end + 22 > bytes.byteLength) {
    throw new NativeExtractionError('MALFORMED', 'Office package has no central directory');
  }
  const entries = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff || offset + directorySize > bytes.byteLength) {
    throw new NativeExtractionError('LIMIT_EXCEEDED', 'ZIP64 or oversized Office package is not supported');
  }
  let declaredOutput = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.byteLength || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new NativeExtractionError('MALFORMED', 'Office package central directory is invalid');
    }
    const compressed = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const filenameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    declaredOutput += uncompressed;
    if (declaredOutput > 64 * 1024 * 1024 || (compressed > 0 && uncompressed / compressed > 100)) {
      throw new NativeExtractionError('LIMIT_EXCEEDED', 'Office package exceeds decompression limits');
    }
    offset += 46 + filenameLength + extraLength + commentLength;
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  // ZIP comments are bounded by a uint16, so EOCD must occur within the final
  // 65,557 bytes. Scanning backwards avoids trusting attacker-provided offsets.
  const floor = Math.max(0, bytes.byteLength - 65_557);
  for (let index = bytes.byteLength - 22; index >= floor; index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function xmlText(value: string, tag: 'w:t' | 'a:t' | 't'): string[] {
  const expression = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const output: string[] = [];
  for (const match of value.matchAll(expression)) output.push(unescapeXml(match[1]));
  return output;
}

function unescapeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:#(x[\da-fA-F]+|\d+)|quot|apos|lt|gt|amp);/g, (entity, code) => {
      if (!code) return ({ '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' } as Record<string, string>)[entity] ?? entity;
      const number = String(code).toLowerCase().startsWith('x') ? Number.parseInt(String(code).slice(1), 16) : Number.parseInt(String(code), 10);
      return Number.isSafeInteger(number) && number >= 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : '';
    });
}

function extractDocx(bytes: Buffer): string {
  const document = unzip(bytes)['word/document.xml'];
  if (!document) throw new NativeExtractionError('MALFORMED', 'DOCX document XML is missing');
  return xmlText(Buffer.from(document).toString('utf8'), 'w:t').join(' ');
}

function extractPptx(bytes: Buffer): string {
  const entries = unzip(bytes);
  const slides = Object.entries(entries)
    .filter(([path]) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort(([left], [right]) => slideNumber(left) - slideNumber(right));
  if (!slides.length) throw new NativeExtractionError('MALFORMED', 'PPTX slide XML is missing');
  return slides.map(([path, content]) => `Slide ${slideNumber(path)}: ${xmlText(Buffer.from(content).toString('utf8'), 'a:t').join(' ')}`).join('\n');
}

function slideNumber(path: string): number {
  return Number(/slide(\d+)\.xml$/.exec(path)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function sheetNumber(path: string): number {
  return Number(/sheet(\d+)\.xml$/.exec(path)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function extractXlsx(bytes: Buffer): string {
  const entries = unzip(bytes);
  const shared = entries['xl/sharedStrings.xml']
    ? xmlText(Buffer.from(entries['xl/sharedStrings.xml']).toString('utf8'), 't')
    : [];
  const sheets = Object.entries(entries)
    .filter(([path]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .sort(([left], [right]) => sheetNumber(left) - sheetNumber(right));
  if (!sheets.length) throw new NativeExtractionError('MALFORMED', 'XLSX worksheet XML is missing');
  const output: string[] = [];
  for (const [path, sheet] of sheets) {
    output.push(`Sheet ${sheetNumber(path)}`);
    const source = Buffer.from(sheet).toString('utf8');
    for (const cell of source.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const type = /\bt="([^"]+)"/.exec(cell[1])?.[1];
      const body = cell[2];
      const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(body)?.[1];
      const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const inline = xmlText(body, 't').join(' ');
      if (formula) output.push(unescapeXml(formula));
      if (type === 's' && raw && /^\d+$/.test(raw)) output.push(shared[Number(raw)] ?? '');
      else if (type === 'inlineStr') output.push(inline);
      else if (raw) output.push(unescapeXml(raw));
    }
  }
  return output.filter(Boolean).join('\n');
}

function extractCsv(source: string): string {
  const rows: string[] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row.filter(Boolean).join(' ')); row = []; field = '';
    } else field += character;
  }
  row.push(field);
  if (row.some(Boolean)) rows.push(row.filter(Boolean).join(' '));
  return rows.join('\n');
}

function boundedText(value: string, maxChars: number): NativeExtractionResult {
  const normalized = value.replace(/\r\n/g, '\n').replaceAll(String.fromCharCode(0), '').trim();
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };
  return { text: normalized.slice(0, maxChars), truncated: true };
}
