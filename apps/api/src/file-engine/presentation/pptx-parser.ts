import { PresentationPackageError, PptxPackageReader } from './pptx-package-reader.js';
import type {
  PresentationAlignment,
  PresentationElement,
  PresentationGroupElement,
  PresentationImageElement,
  PresentationModel,
  PresentationParagraph,
  PresentationShapeElement,
  PresentationSlideDescriptor,
  PresentationSlideModel,
  PresentationTextElement,
  PresentationTextRun,
  PresentationUnsupportedElement,
} from './presentation-model.js';
import { PRESENTATION_LIMITS } from './presentation-limits.js';

type Relationship = { id: string; target: string; type: string; targetMode?: string };
type Transform = { x: number; y: number; width: number; height: number; rotation: number };
type InheritedGeometry = Map<string, Transform>;

export interface PresentationAsset {
  assetId: string;
  path: string;
  mimeType: string;
}

export interface PresentationSlideSource {
  id: string;
  path: string;
  rels: Map<string, Relationship>;
  layoutPath: string | null;
  name: string | null;
  hidden: boolean;
}

export interface ParsedPresentation {
  model: PresentationModel;
  slides: Map<string, PresentationSlideSource>;
  assets: Map<string, PresentationAsset>;
}

function localName(name: string): string {
  const separator = name.indexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function attr(xml: string, name: string): string | null {
  const escaped = name;
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'u').exec(xml);
  return match?.[2] ?? null;
}

function numberAttr(xml: string, name: string, fallback = 0): number {
  const value = Number(attr(xml, name));
  return Number.isFinite(value) ? value : fallback;
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#xA;', '\n')
    .replaceAll('&#10;', '\n')
    .replaceAll('&#13;', '\r')
    .replaceAll('&amp;', '&')
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_match, decimal: string) => String.fromCodePoint(Number(decimal)));
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function blocks(xml: string, names: ReadonlySet<string>): Array<{ name: string; start: number; end: number; xml: string }> {
  const result: Array<{ name: string; start: number; end: number; xml: string }> = [];
  const stack: Array<{ name: string; start: number }> = [];
  const token = /<\/?([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)(?:\s[^<>]*?)?\/?>(?:)/gu;
  for (const match of xml.matchAll(token)) {
    const raw = match[0] ?? '';
    const qualified = match[1] ?? '';
    const name = localName(qualified);
    if (!names.has(name)) continue;
    const isClosing = raw.startsWith('</');
    const isSelfClosing = /\/\s*>$/u.test(raw);
    const start = match.index ?? 0;
    if (isClosing) {
      const open = stack.pop();
      if (open?.name === name) result.push({ name, start: open.start, end: start + raw.length, xml: xml.slice(open.start, start + raw.length) });
    } else if (!isSelfClosing) {
      stack.push({ name, start });
    } else {
      result.push({ name, start, end: start + raw.length, xml: raw });
    }
  }
  return result.sort((left, right) => left.start - right.start);
}

function topLevelElementBlocks(xml: string): Array<{ name: string; start: number; end: number; xml: string }> {
  const candidates = blocks(xml, new Set(['sp', 'pic', 'cxnSp', 'grpSp', 'graphicFrame']));
  return candidates.filter((candidate) => !candidates.some((parent) => parent.name === 'grpSp' && parent.start < candidate.start && parent.end > candidate.end));
}

function firstBlock(xml: string, name: string): string | null {
  const opening = new RegExp(`<([A-Za-z_][\\w.-]*:)?${name}\\b[^>]*>`, 'iu').exec(xml);
  if (!opening) return null;
  const start = opening.index;
  const closing = new RegExp(`</([A-Za-z_][\\w.-]*:)?${name}\\s*>`, 'iu').exec(xml.slice(start + opening[0].length));
  return closing ? xml.slice(start, start + opening[0].length + closing.index! + closing[0].length) : opening[0];
}

function relationships(reader: PptxPackageReader, partPath: string): Map<string, Relationship> {
  const relsPath = partPath.includes('/') ? `${partPath.slice(0, partPath.lastIndexOf('/'))}/_rels/${partPath.slice(partPath.lastIndexOf('/') + 1)}.rels` : `_rels/${partPath}.rels`;
  if (!reader.has(relsPath)) return new Map();
  const xml = reader.text(relsPath);
  const result = new Map<string, Relationship>();
  const pattern = /<Relationship\b([^>]*?)\/?>(?:<\/Relationship>)?/giu;
  for (const match of xml.matchAll(pattern)) {
    const body = match[1] ?? '';
    const id = attr(body, 'Id');
    const target = attr(body, 'Target');
    const type = attr(body, 'Type') ?? '';
    if (id && target) result.set(id, { id, target, type, targetMode: attr(body, 'TargetMode') ?? undefined });
  }
  return result;
}

function token(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 100);
}

export function presentationSlideId(sourceId: string): string { return `slide-${token(sourceId)}`; }
export function presentationElementId(slideId: string, sourceId: string): string { return `element-${token(slideId)}-${token(sourceId)}`; }

function presentationRelationship(reader: PptxPackageReader, relationship: Relationship, sourcePath: string): string | null {
  return reader.resolveTarget(sourcePath, relationship.target);
}

function mimeForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return extension === 'png' ? 'image/png' : extension === 'gif' ? 'image/gif' : extension === 'svg' ? 'image/svg+xml' : 'image/jpeg';
}

function color(xml: string | null, themeColors = new Map<string, string>()): string | null {
  if (!xml) return null;
  const rgb = /<([A-Za-z_][\w.-]*:)?srgbClr\b[^>]*\bval\s*=\s*(["'])([0-9a-f]{6})\2/iu.exec(xml);
  if (rgb?.[3]) return `#${rgb[3]}`;
  const scheme = /<([A-Za-z_][\w.-]*:)?schemeClr\b[^>]*\bval\s*=\s*(["'])([^"']+)\2/iu.exec(xml);
  return scheme?.[4] ? themeColors.get(scheme[4]) ?? null : null;
}

function fillColor(xml: string, themeColors: Map<string, string>): string | null {
  const fill = firstBlock(xml, 'solidFill');
  return color(fill, themeColors);
}

function parseTransform(xml: string | null): Transform | null {
  if (!xml) return null;
  const xfrm = firstBlock(xml, 'xfrm');
  if (!xfrm) return null;
  return {
    x: numberAttr(firstBlock(xfrm, 'off') ?? '', 'x'),
    y: numberAttr(firstBlock(xfrm, 'off') ?? '', 'y'),
    width: numberAttr(firstBlock(xfrm, 'ext') ?? '', 'cx'),
    height: numberAttr(firstBlock(xfrm, 'ext') ?? '', 'cy'),
    rotation: numberAttr(xfrm, 'rot') / 60_000,
  };
}

function combineTransform(parent: Transform, child: Transform, groupXml: string | null): Transform {
  const group = groupXml ? firstBlock(groupXml, 'xfrm') : null;
  const childOffset = group ? firstBlock(group, 'chOff') : null;
  const childExtent = group ? firstBlock(group, 'chExt') : null;
  const sourceX = numberAttr(childOffset ?? '', 'x');
  const sourceY = numberAttr(childOffset ?? '', 'y');
  const sourceWidth = numberAttr(childExtent ?? '', 'cx', 1) || 1;
  const sourceHeight = numberAttr(childExtent ?? '', 'cy', 1) || 1;
  const sx = parent.width / sourceWidth;
  const sy = parent.height / sourceHeight;
  return {
    x: parent.x + (child.x - sourceX) * sx,
    y: parent.y + (child.y - sourceY) * sy,
    width: child.width * sx,
    height: child.height * sy,
    rotation: parent.rotation + child.rotation,
  };
}

function alignment(value: string | null): PresentationAlignment {
  return value === 'ctr' ? 'center' : value === 'r' ? 'right' : value === 'just' ? 'justified' : 'left';
}

function parseRun(id: string, xml: string, rels: Map<string, Relationship>, reader: PptxPackageReader, slidePath: string, themeColors: Map<string, string>, defaultFont: string | null): PresentationTextRun {
  const rPr = firstBlock(xml, 'rPr') ?? firstBlock(xml, 'endParaRPr') ?? '';
  const linkId = attr(rPr, 'r:id');
  const relation = linkId ? rels.get(linkId) : undefined;
  const href = relation?.targetMode?.toLowerCase() === 'external' && ['http:', 'https:', 'mailto:'].some((scheme) => relation.target.toLowerCase().startsWith(scheme)) ? relation.target : null;
  const latin = /<([A-Za-z_][\w.-]*:)?latin\b[^>]*\btypeface\s*=\s*(["'])(.*?)\2/iu.exec(rPr)?.[3] ?? defaultFont;
  const size = Number(attr(rPr, 'sz'));
  return {
    id,
    text: [...xml.matchAll(/<([A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/([A-Za-z_][\w.-]*:)?t\s*>/giu)].map((match) => decodeXml(match[2] ?? '')).join(''),
    bold: attr(rPr, 'b') === '1' || attr(rPr, 'b') === 'true',
    italic: attr(rPr, 'i') === '1' || attr(rPr, 'i') === 'true',
    underline: Boolean(attr(rPr, 'u') && attr(rPr, 'u') !== 'none'),
    fontFamily: latin ?? null,
    fontSize: Number.isFinite(size) && size > 0 ? size / 100 : null,
    color: color(firstBlock(rPr, 'solidFill'), themeColors),
    link: href ? { href } : null,
  };
}

function parseParagraph(id: string, xml: string, rels: Map<string, Relationship>, reader: PptxPackageReader, slidePath: string, themeColors: Map<string, string>, defaultFont: string | null): PresentationParagraph {
  const pPr = firstBlock(xml, 'pPr') ?? '';
  const bulletChar = /<([A-Za-z_][\w.-]*:)?buChar\b[^>]*\bchar\s*=\s*(["'])(.*?)\2/iu.exec(pPr)?.[3];
  const bulletNumber = /<([A-Za-z_][\w.-]*:)?buAutoNum\b[^>]*\btype\s*=\s*(["'])(.*?)\2/iu.exec(pPr)?.[3];
  const level = Number(attr(pPr, 'lvl')) || 0;
  const runs: PresentationTextRun[] = [];
  const runOrBreak = /<([A-Za-z_][\w.-]*:)?(?:r\b[\s\S]*?<\/([A-Za-z_][\w.-]*:)?r\s*>|br\b[^>]*\/?>(?:))/giu;
  for (const match of xml.matchAll(runOrBreak)) {
    const raw = match[0] ?? '';
    if (/br\b/iu.test(raw)) {
      if (runs.length) runs[runs.length - 1].text += '\n';
    } else runs.push(parseRun(`${id}-run-${runs.length}`, raw, rels, reader, slidePath, themeColors, defaultFont));
  }
  return {
    id,
    runs,
    alignment: alignment(attr(pPr, 'algn')),
    bullet: bulletChar ? { kind: 'bullet', value: decodeXml(bulletChar), level } : bulletNumber ? { kind: 'number', value: bulletNumber, level } : null,
  };
}

function parseTextBody(xml: string, rels: Map<string, Relationship>, reader: PptxPackageReader, slidePath: string, themeColors: Map<string, string>, defaultFont: string | null): PresentationParagraph[] {
  return blocks(xml, new Set(['p'])).map((paragraph, index) => parseParagraph(`p-${index}`, paragraph.xml, rels, reader, slidePath, themeColors, defaultFont));
}

function placeholderType(xml: string): string | null {
  const ph = firstBlock(xml, 'ph');
  return attr(ph ?? '', 'type');
}

function parseTheme(reader: PptxPackageReader, themePath: string | null): { colors: Map<string, string>; font: string | null } {
  if (!themePath) return { colors: new Map(), font: null };
  const xml = reader.text(themePath);
  const colors = new Map<string, string>();
  for (const match of xml.matchAll(/<([A-Za-z_][\w.-]*:)?([A-Za-z][\w]*)\b[^>]*>([\s\S]*?)<\/\1?\2\s*>/giu)) {
    const key = match[2];
    const value = color(match[0]);
    if (value) colors.set(key, value);
  }
  const font = /<([A-Za-z_][\w.-]*:)?latin\b[^>]*\btypeface\s*=\s*(["'])(.*?)\2/iu.exec(xml)?.[3] ?? null;
  return { colors, font };
}

function slideBackground(xml: string, themeColors: Map<string, string>): string | null {
  const background = firstBlock(xml, 'bg');
  return fillColor(background ?? '', themeColors);
}

function textShapeEditable(xml: string): { editable: boolean; reason?: string } {
  if (/<([A-Za-z_][\w.-]*:)?(?:fld|tab|hlinkClick)\b/iu.test(xml)) return { editable: false, reason: 'This text shape contains unsupported inline PowerPoint content.' };
  return { editable: true };
}

export class PptxParser {
  private readonly presentationXml: string;
  private readonly presentationRels: Map<string, Relationship>;
  private readonly slideSources = new Map<string, PresentationSlideSource>();
  private readonly assets = new Map<string, PresentationAsset>();
  private readonly width: number;
  private readonly height: number;
  private readonly themeColors = new Map<string, string>();
  private readonly defaultFont: string | null;

  constructor(private readonly reader: PptxPackageReader) {
    this.presentationXml = reader.text('ppt/presentation.xml');
    this.presentationRels = relationships(reader, 'ppt/presentation.xml');
    const size = firstBlock(this.presentationXml, 'sldSz');
    this.width = numberAttr(size ?? '', 'cx', 9_144_000);
    this.height = numberAttr(size ?? '', 'cy', 5_143_500);
    this.indexSlides();
    const themeInfo = this.resolveTheme();
    this.defaultFont = themeInfo.font;
    for (const [key, value] of themeInfo.colors) this.themeColors.set(key, value);
  }

  static parse(reader: PptxPackageReader, storageRevision?: string, editable = true): ParsedPresentation {
    return new PptxParser(reader).parseManifest(storageRevision, editable);
  }

  parseManifest(storageRevision?: string, editable = true): ParsedPresentation {
    const slides = [...this.slideSources.values()].map((slide, index) => ({
      id: slide.id,
      index,
      name: slide.name,
      hidden: slide.hidden,
      width: this.width,
      height: this.height,
      thumbnailCapability: true,
    } satisfies PresentationSlideDescriptor));
    if (!slides.length) throw new PresentationPackageError('PPTX presentation contains no slides');
    return {
      model: {
        version: 1,
        id: 'presentation',
        width: this.width,
        height: this.height,
        slides,
        activeSlideId: slides[0].id,
        editable,
        ...(storageRevision ? { storageRevision } : {}),
        hasUnsupportedContent: [...this.reader.allEntries().keys()].some((path) => /(?:^|\/)(?:charts|diagrams|embeddings)\//iu.test(path)),
      },
      slides: new Map(this.slideSources),
      assets: new Map(this.assets),
    };
  }

  slide(slideId: string, assetUrl?: (assetId: string) => string): PresentationSlideModel {
    const source = this.slideSources.get(slideId);
    if (!source) throw new Error('The presentation slide does not exist');
    const xml = this.reader.text(source.path);
    const themeInfo = { colors: this.themeColors, font: this.defaultFont };
    const inheritedGeometry = this.layoutGeometry(source.layoutPath);
    const tree = firstBlock(xml, 'spTree') ?? '';
    const elements: PresentationElement[] = [];
    const direct = topLevelElementBlocks(tree);
    for (const element of direct) {
      const parsed = this.parseElement(element.xml, source, elements.length, inheritedGeometry, assetUrl, themeInfo, null);
      if (parsed) elements.push(parsed);
    }
    const unsupportedFeatures = [...new Set(elements.filter((element) => element.type === 'unsupported').map((element) => element.label))];
    return { version: 1, id: source.id, index: this.indexOf(source.id), width: this.width, height: this.height, background: slideBackground(xml, this.themeColors), elements, unsupportedFeatures };
  }

  asset(assetId: string): PresentationAsset | null { return this.assets.get(assetId) ?? null; }
  source(slideId: string): PresentationSlideSource | null { return this.slideSources.get(slideId) ?? null; }
  slidePath(slideId: string): string | null { return this.slideSources.get(slideId)?.path ?? null; }
  allSlideIds(): string[] { return [...this.slideSources.keys()]; }

  private indexSlides(): void {
    const slideList = firstBlock(this.presentationXml, 'sldIdLst') ?? '';
    const relations = [...blocks(slideList, new Set(['sldId']))];
    if (relations.length > PRESENTATION_LIMITS.maxSlides) throw new Error('PPTX presentation contains too many slides');
    for (const relationXml of relations) {
      const relationId = attr(relationXml.xml, 'r:id');
      const numericId = attr(relationXml.xml, 'id');
      if (!relationId || !numericId) continue;
      const relation = this.presentationRels.get(relationId);
      const path = relation ? presentationRelationship(this.reader, relation, 'ppt/presentation.xml') : null;
      if (!path || !path.startsWith('ppt/slides/')) continue;
      const slideXml = this.reader.text(path);
      const slideRels = relationships(this.reader, path);
      const layoutRelation = [...slideRels.values()].find((candidate) => candidate.type.endsWith('/slideLayout'));
      const layoutPath = layoutRelation ? presentationRelationship(this.reader, layoutRelation, path) : null;
      const id = presentationSlideId(numericId);
      const name = attr(firstBlock(slideXml, 'cSld') ?? '', 'name');
      const hidden = attr(relationXml.xml, 'show') === '0' || attr(relationXml.xml, 'show') === 'false';
      this.slideSources.set(id, { id, path, rels: slideRels, layoutPath, name, hidden });
      for (const element of blocks(firstBlock(slideXml, 'spTree') ?? '', new Set(['pic']))) {
        const relId = attr(firstBlock(element.xml, 'blip') ?? '', 'r:embed');
        const imageRelation = relId ? slideRels.get(relId) : undefined;
        const imagePath = imageRelation ? presentationRelationship(this.reader, imageRelation, path) : null;
        if (!relId || !imagePath || !imagePath.startsWith('ppt/media/')) continue;
        const assetId = `asset-${token(id)}-${token(relId)}`;
        this.assets.set(assetId, { assetId, path: imagePath, mimeType: mimeForPath(imagePath) });
      }
    }
  }

  private resolveTheme(): { colors: Map<string, string>; font: string | null } {
    const firstSlide = [...this.slideSources.values()][0];
    if (!firstSlide?.layoutPath) return { colors: new Map(), font: null };
    const layoutRels = relationships(this.reader, firstSlide.layoutPath);
    const masterRelation = [...layoutRels.values()].find((candidate) => candidate.type.endsWith('/slideMaster'));
    const masterPath = masterRelation ? presentationRelationship(this.reader, masterRelation, firstSlide.layoutPath) : null;
    if (!masterPath) return { colors: new Map(), font: null };
    const masterRels = relationships(this.reader, masterPath);
    const themeRelation = [...masterRels.values()].find((candidate) => candidate.type.endsWith('/theme'));
    const themePath = themeRelation ? presentationRelationship(this.reader, themeRelation, masterPath) : null;
    return parseTheme(this.reader, themePath);
  }

  private indexOf(slideId: string): number { return [...this.slideSources.keys()].indexOf(slideId); }

  private layoutGeometry(layoutPath: string | null): InheritedGeometry {
    const result: InheritedGeometry = new Map();
    if (!layoutPath || !this.reader.has(layoutPath)) return result;
    const xml = this.reader.text(layoutPath);
    const tree = firstBlock(xml, 'spTree') ?? '';
    for (const element of blocks(tree, new Set(['sp']))) {
      const type = placeholderType(element.xml);
      const transform = parseTransform(firstBlock(element.xml, 'spPr'));
      if (type && transform) result.set(type, transform);
    }
    return result;
  }

  private parseElement(xml: string, source: PresentationSlideSource, ordinal: number, inheritedGeometry: InheritedGeometry, assetUrl: ((assetId: string) => string) | undefined, themeInfo: { colors: Map<string, string>; font: string | null }, parent: { transform: Transform; xml: string } | null): PresentationElement | null {
    const nonVisual = firstBlock(xml, 'cNvPr') ?? '';
    const sourceId = attr(nonVisual, 'id') ?? String(ordinal + 1);
    const id = presentationElementId(source.id, sourceId);
    const placeholder = placeholderType(xml);
    const transformSource = xml.match(/<([A-Za-z_][\w.-]*:)?grpSp\b/iu) ? firstBlock(xml, 'grpSpPr') : firstBlock(xml, 'spPr') ?? firstBlock(xml, 'xfrm');
    let transform = parseTransform(transformSource) ?? (placeholder ? inheritedGeometry.get(placeholder) ?? null : null);
    if (!transform) transform = { x: 0, y: 0, width: 0, height: 0, rotation: 0 };
    if (parent) transform = combineTransform(parent.transform, transform, parent.xml);
    const base = { id, ...transform, zIndex: ordinal, placeholderType: placeholder, editable: { text: false, move: false, resize: false } };
    if (xml.match(/<([A-Za-z_][\w.-]*:)?grpSp\b/iu)) {
      const children: PresentationElement[] = [];
      const opening = /<([A-Za-z_][\w.-]*:)?grpSp\b[^>]*>/iu.exec(xml);
      const closing = /<\/([A-Za-z_][\w.-]*:)?grpSp\s*>/iu.exec(xml.slice((opening?.index ?? 0) + (opening?.[0].length ?? 0)));
      const inner = opening && closing ? xml.slice((opening.index ?? 0) + opening[0].length, (opening.index ?? 0) + opening[0].length + closing.index!) : '';
      for (const [childIndex, child] of topLevelElementBlocks(inner).entries()) {
        const parsed = this.parseElement(child.xml, source, childIndex, inheritedGeometry, assetUrl, themeInfo, { transform, xml });
        if (parsed) children.push({ ...parsed, editable: { text: false, move: false, resize: false }, ...(parsed.type === 'text' || parsed.type === 'image' || parsed.type === 'shape' ? { readonlyReason: 'Grouped elements are read-only in V1.' } : {}) } as PresentationElement);
      }
      return { ...base, type: 'group', children, editable: { text: false, move: false, resize: false }, readonlyReason: 'Grouped elements are read-only in V1.' } satisfies PresentationGroupElement;
    }
    const txBody = firstBlock(xml, 'txBody');
    if (txBody) {
      const safe = textShapeEditable(txBody);
      const paragraphs = parseTextBody(txBody, source.rels, this.reader, source.path, themeInfo.colors, themeInfo.font);
      const shapeProperties = firstBlock(xml, 'spPr') ?? '';
      const result: PresentationTextElement = {
        ...base,
        type: 'text',
        shapeType: attr(firstBlock(shapeProperties, 'prstGeom') ?? '', 'prst') ?? 'rect',
        paragraphs,
        fillColor: fillColor(shapeProperties, themeInfo.colors),
        borderColor: color(firstBlock(firstBlock(shapeProperties, 'ln') ?? '', 'solidFill'), themeInfo.colors),
        borderWidth: numberAttr(firstBlock(shapeProperties, 'ln') ?? '', 'w') / 100,
        editable: { text: safe.editable, move: safe.editable && transform.width > 0 && transform.height > 0, resize: safe.editable && transform.width > 0 && transform.height > 0 },
        ...(safe.reason ? { readonlyReason: safe.reason } : {}),
      };
      return result;
    }
    if (xml.match(/<([A-Za-z_][\w.-]*:)?pic\b/iu)) {
      const relId = attr(firstBlock(xml, 'blip') ?? '', 'r:embed');
      const assetId = relId ? `asset-${token(source.id)}-${token(relId)}` : null;
      const asset = assetId ? this.assets.get(assetId) : null;
      if (!assetId || !asset) return { ...base, type: 'unsupported', label: 'Unsupported object', readonlyReason: 'The image relationship is unavailable.', editable: { text: false, move: false, resize: false } } satisfies PresentationUnsupportedElement;
      const cropNode = firstBlock(xml, 'srcRect');
      const crop = cropNode ? { left: numberAttr(cropNode, 'l') / 100_000, top: numberAttr(cropNode, 't') / 100_000, right: numberAttr(cropNode, 'r') / 100_000, bottom: numberAttr(cropNode, 'b') / 100_000 } : null;
      return { ...base, type: 'image', assetId, ...(assetUrl ? { src: assetUrl(assetId) } : {}), ...(crop ? { crop } : {}), editable: { text: false, move: true, resize: true } } satisfies PresentationImageElement;
    }
    if (xml.match(/<([A-Za-z_][\w.-]*:)?graphicFrame\b/iu)) {
      const label = /<([A-Za-z_][\w.-]*:)?chart\b/iu.test(xml) ? 'Chart' : /<([A-Za-z_][\w.-]*:)?(relIds|dataModelExt)\b/iu.test(xml) ? 'SmartArt' : /<([A-Za-z_][\w.-]*:)?tbl\b/iu.test(xml) ? 'Table' : 'Unsupported object';
      return { ...base, type: 'unsupported', label, readonlyReason: `${label} content is preserved but not editable in V1.` } satisfies PresentationUnsupportedElement;
    }
    const shapeProperties = firstBlock(xml, 'spPr') ?? '';
    const shapeType = attr(firstBlock(shapeProperties, 'prstGeom') ?? '', 'prst') ?? (xml.match(/<([A-Za-z_][\w.-]*:)?cxnSp\b/iu) ? 'line' : 'rect');
    const supportedShape = new Set(['rect', 'roundRect', 'ellipse', 'oval', 'line', 'straightConnector1', 'triangle', 'diamond']);
    const shape: PresentationShapeElement = {
      ...base,
      type: 'shape',
      shapeType,
      fillColor: fillColor(shapeProperties, themeInfo.colors),
      borderColor: color(firstBlock(firstBlock(shapeProperties, 'ln') ?? '', 'solidFill'), themeInfo.colors),
      borderWidth: numberAttr(firstBlock(shapeProperties, 'ln') ?? '', 'w') / 100,
      editable: { text: false, move: supportedShape.has(shapeType), resize: supportedShape.has(shapeType) },
      ...(supportedShape.has(shapeType) ? {} : { readonlyReason: 'This PowerPoint shape is rendered as a simplified read-only preview.' }),
    };
    return shape;
  }
}

export function textForElement(element: PresentationTextElement): string {
  return element.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join('')).join('\n');
}

export function escapePresentationText(value: string): string { return escapeXml(value); }
