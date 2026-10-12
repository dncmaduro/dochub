import { zipSync } from 'fflate';
import { PptxPackageReader } from './pptx-package-reader.js';
import { PptxParser } from './pptx-parser.js';
import { createPresentationSourceMap, type PresentationRange } from './pptx-source-map.js';
import { PresentationEditValidationError, type PresentationElementPatch, type PresentationParagraphPatch, type PresentationPatchRequest, type PresentationTextRunPatch } from './presentation-edit.types.js';
import type { PresentationElement } from './presentation-model.js';
import { PRESENTATION_LIMITS } from './presentation-limits.js';

interface Replacement { start: number; end: number; value: string }

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function patchAttribute(xml: string, name: string, value: string): string {
  const escaped = name;
  const pattern = new RegExp(`(\\s${escaped}\\s*=\\s*)(["'])(.*?)\\2`, 'u');
  if (pattern.test(xml)) return xml.replace(pattern, (_match, prefix: string, quote: string) => `${prefix}${quote}${value}${quote}`);
  const close = xml.indexOf('>');
  return close < 0 ? xml : `${xml.slice(0, close)} ${name}="${value}"${xml.slice(close)}`;
}

function patchNestedAttribute(xml: string, elementName: string, attributeName: string, value: string): string {
  const pattern = new RegExp(`(<(?:[A-Za-z_][\\w.-]*:)?${elementName}\\b[^>]*>)`, 'iu');
  const match = pattern.exec(xml);
  if (!match) return xml;
  return xml.slice(0, match.index) + patchAttribute(match[1] ?? '', attributeName, value) + xml.slice(match.index + (match[1]?.length ?? 0));
}

function runProperties(run: PresentationTextRunPatch): string {
  const attributes = [
    run.bold ? ' b="1"' : '',
    run.italic ? ' i="1"' : '',
    run.underline ? ' u="sng"' : '',
    run.fontSize == null ? '' : ` sz="${Math.round(run.fontSize * 100)}"`,
  ].join('');
  const font = run.fontFamily ? `<a:latin typeface="${escapeXml(run.fontFamily)}"/>` : '';
  const fill = run.color ? `<a:solidFill><a:srgbClr val="${run.color.slice(1)}"/></a:solidFill>` : '';
  return `<a:rPr lang="en-US"${attributes}>${fill}${font}</a:rPr>`;
}

function runXml(run: PresentationTextRunPatch): string {
  const pieces = run.text.split('\n');
  return pieces.map((piece, index) => `${index ? '<a:br/>' : ''}<a:r>${runProperties(run)}<a:t${/^\s|\s$/u.test(piece) ? ' xml:space="preserve"' : ''}>${escapeXml(piece)}</a:t></a:r>`).join('');
}

function paragraphXml(paragraph: PresentationParagraphPatch): string {
  const alignment = paragraph.alignment && paragraph.alignment !== 'left' ? ` algn="${paragraph.alignment === 'center' ? 'ctr' : paragraph.alignment === 'right' ? 'r' : 'just'}"` : '';
  const bullet = paragraph.bullet?.kind === 'bullet'
    ? `<a:buChar char="${escapeXml(paragraph.bullet.value ?? '•')}"/>`
    : paragraph.bullet?.kind === 'number'
      ? `<a:buAutoNum type="${escapeXml(paragraph.bullet.value ?? 'arabicPeriod')}"/>`
      : '';
  const level = paragraph.bullet?.level ? ` lvl="${paragraph.bullet.level}"` : '';
  const pPr = alignment || bullet ? `<a:pPr${alignment}${level}>${bullet}</a:pPr>` : '';
  const runs = paragraph.runs.length ? paragraph.runs.map(runXml).join('') : '<a:r><a:rPr/><a:t></a:t></a:r>';
  return `<a:p>${pPr}${runs}<a:endParaRPr/></a:p>`;
}

function patchTextBody(xml: string, paragraphs: PresentationParagraphPatch[]): string {
  const paragraphPattern = /<([A-Za-z_][\w.-]*:)?p(?:\s[^<>]*?)?>[\s\S]*?<\/([A-Za-z_][\w.-]*:)?p\s*>/giu;
  const matches = [...xml.matchAll(paragraphPattern)];
  const replacement = paragraphs.map(paragraphXml).join('');
  if (!matches.length) return xml.replace(/<\/([A-Za-z_][\w.-]*:)?txBody\s*>/iu, `${replacement}</$1txBody>`);
  const first = matches[0];
  const last = matches[matches.length - 1];
  const start = first.index ?? 0;
  const end = (last.index ?? 0) + last[0].length;
  return xml.slice(0, start) + replacement + xml.slice(end);
}

function patchTransform(xml: string, geometry: PresentationElementPatch['geometry']): string {
  let next = xml;
  const offX = geometry?.x;
  const offY = geometry?.y;
  const width = geometry?.width;
  const height = geometry?.height;
  if (offX !== undefined) next = patchNestedAttribute(next, 'off', 'x', String(Math.round(offX)));
  if (offY !== undefined) next = patchNestedAttribute(next, 'off', 'y', String(Math.round(offY)));
  if (width !== undefined) next = patchNestedAttribute(next, 'ext', 'cx', String(Math.round(width)));
  if (height !== undefined) next = patchNestedAttribute(next, 'ext', 'cy', String(Math.round(height)));
  return next;
}

function replace(source: string, replacements: Replacement[]): string {
  return [...replacements].sort((left, right) => right.start - left.start).reduce((current, item) => current.slice(0, item.start) + item.value + current.slice(item.end), source);
}

function elementById(slide: ReturnType<PptxParser['slide']>, elementId: string): PresentationElement | null {
  const visit = (elements: PresentationElement[]): PresentationElement | null => {
    for (const element of elements) {
      if (element.id === elementId) return element;
      if (element.type === 'group') { const nested = visit(element.children); if (nested) return nested; }
    }
    return null;
  };
  return visit(slide.elements);
}

function rangeValue(xml: string, range: PresentationRange): string { return xml.slice(range.start, range.end); }

export class PptxPatcher {
  static assertWithinLimits(request: PresentationPatchRequest): void {
    let count = 0;
    for (const slide of request.slides) for (const _element of slide.elements) {
      count += 1;
      if (count > PRESENTATION_LIMITS.maxPatchElements) throw new PresentationEditValidationError('Too many presentation edits.');
    }
  }

  static apply(sourceBytes: Uint8Array, request: PresentationPatchRequest): { bytes: Buffer } {
    this.assertWithinLimits(request);
    const reader = PptxPackageReader.fromBytes(sourceBytes);
    const parser = new PptxParser(reader);
    const sourceMap = createPresentationSourceMap(reader, parser);
    const entries: Record<string, Uint8Array> = {};
    for (const [path, bytes] of reader.allEntries()) entries[path] = bytes;
    for (const slidePatch of request.slides) {
      const source = sourceMap.slides.get(slidePatch.slideId);
      if (!source) throw new PresentationEditValidationError('The presentation slide does not exist.');
      const slideModel = parser.slide(slidePatch.slideId);
      let xml = reader.text(source.path);
      const replacements: Replacement[] = [];
      for (const patch of slidePatch.elements) {
        const mapped = source.elements.get(patch.elementId);
        const element = elementById(slideModel, patch.elementId);
        if (!mapped || !element) throw new PresentationEditValidationError('The presentation element does not exist.');
        if (patch.textState) {
          if (element.type !== 'text' || !element.editable.text || !mapped.textBody) throw new PresentationEditValidationError('This presentation text element is read-only.');
          const current = rangeValue(xml, mapped.textBody);
          replacements.push({ start: mapped.textBody.start, end: mapped.textBody.end, value: patchTextBody(current, patch.textState.paragraphs) });
        }
        if (patch.geometry) {
          if (!element.editable.move || !element.editable.resize || !mapped.transform) throw new PresentationEditValidationError('This presentation element geometry is read-only.');
          const nextWidth = patch.geometry.width ?? element.width;
          const nextHeight = patch.geometry.height ?? element.height;
          if (nextWidth <= 0 || nextHeight <= 0 || nextWidth > slideModel.width * 2 || nextHeight > slideModel.height * 2) throw new PresentationEditValidationError('The presentation geometry is outside safe limits.');
          const current = rangeValue(xml, mapped.transform);
          replacements.push({ start: mapped.transform.start, end: mapped.transform.end, value: patchTransform(current, patch.geometry) });
        }
      }
      entries[source.path] = new TextEncoder().encode(replace(xml, replacements));
    }
    return { bytes: Buffer.from(zipSync(entries)) };
  }
}
