import { PptxPackageReader } from './pptx-package-reader.js';
import { presentationElementId, type PptxParser } from './pptx-parser.js';

export interface PresentationRange { start: number; end: number }
export interface PresentationElementSource {
  elementId: string;
  sourceId: string;
  start: number;
  end: number;
  kind: 'sp' | 'pic' | 'cxnSp' | 'grpSp' | 'graphicFrame';
  transform: PresentationRange | null;
  textBody: PresentationRange | null;
}

export interface PresentationSourceMap {
  slides: Map<string, { path: string; elements: Map<string, PresentationElementSource> }>;
}

function localName(value: string): string {
  const index = value.indexOf(':');
  return index >= 0 ? value.slice(index + 1) : value;
}

function blockRange(xml: string, name: string, offset = 0): PresentationRange | null {
  const opening = new RegExp(`<([A-Za-z_][\\w.-]*:)?${name}\\b[^>]*>`, 'iu').exec(xml.slice(offset));
  if (!opening) return null;
  const start = offset + opening.index;
  const closing = new RegExp(`</([A-Za-z_][\\w.-]*:)?${name}\\s*>`, 'iu').exec(xml.slice(start + opening[0].length));
  if (closing) return { start, end: start + opening[0].length + closing.index! + closing[0].length };
  return /\/\s*>$/u.test(opening[0]) ? { start, end: start + opening[0].length } : null;
}

function elementBlocks(xml: string): Array<{ kind: PresentationElementSource['kind']; start: number; end: number; xml: string }> {
  const names = new Set(['sp', 'pic', 'cxnSp', 'grpSp', 'graphicFrame']);
  const stack: Array<{ kind: PresentationElementSource['kind']; start: number }> = [];
  const result: Array<{ kind: PresentationElementSource['kind']; start: number; end: number; xml: string }> = [];
  const token = /<\/?([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(?:\s[^<>]*?)?\/?>(?:)/gu;
  for (const match of xml.matchAll(token)) {
    const raw = match[0] ?? '';
    const qualified = match[1] ?? '';
    const kind = localName(qualified) as PresentationElementSource['kind'];
    if (!names.has(kind)) continue;
    const start = match.index ?? 0;
    if (raw.startsWith('</')) {
      const open = stack.pop();
      if (open?.kind === kind) result.push({ kind, start: open.start, end: start + raw.length, xml: xml.slice(open.start, start + raw.length) });
    } else if (!/\/\s*>$/u.test(raw)) stack.push({ kind, start });
    else result.push({ kind, start, end: start + raw.length, xml: raw });
  }
  return result.sort((left, right) => left.start - right.start);
}

function attribute(xml: string, name: string): string | null {
  const escaped = name;
  return new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'u').exec(xml)?.[2] ?? null;
}

export function createPresentationSourceMap(reader: PptxPackageReader, parser: PptxParser): PresentationSourceMap {
  const slides = new Map<string, { path: string; elements: Map<string, PresentationElementSource> }>();
  for (const slideId of parser.allSlideIds()) {
    const source = parser.source(slideId);
    if (!source) continue;
    const xml = reader.text(source.path);
    const elements = new Map<string, PresentationElementSource>();
    for (const element of elementBlocks(xml)) {
      const cNvPr = blockRange(element.xml, 'cNvPr');
      const sourceId = cNvPr ? attribute(element.xml.slice(cNvPr.start, cNvPr.end), 'id') : null;
      if (!sourceId) continue;
      const transformName = element.kind === 'grpSp' ? 'grpSpPr' : 'spPr';
      const transformBlock = blockRange(element.xml, transformName);
      const transform = transformBlock ? blockRange(element.xml, 'xfrm', transformBlock.start) : null;
      const textBody = blockRange(element.xml, 'txBody');
      const elementSource: PresentationElementSource = {
        elementId: presentationElementId(slideId, sourceId),
        sourceId,
        start: element.start,
        end: element.end,
        kind: element.kind,
        transform: transform ? { start: element.start + transform.start, end: element.start + transform.end } : null,
        textBody: textBody ? { start: element.start + textBody.start, end: element.start + textBody.end } : null,
      };
      elements.set(elementSource.elementId, elementSource);
    }
    slides.set(slideId, { path: source.path, elements });
  }
  return { slides };
}
