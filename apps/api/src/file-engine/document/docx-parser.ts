import { XMLParser, XMLValidator } from "fast-xml-parser";
import type {
  DocumentAlignment,
  DocumentBlock,
  DocumentInline,
  DocumentModel,
  DocumentVerticalAlign,
  HeadingBlock,
  ImageBlock,
  InlineImage,
  ListItemBlock,
  ParagraphBlock,
  ParagraphLayout,
  TableBlock,
  TableBorder,
  TableCell,
  TableRow,
  TextRun,
  UnsupportedBlock,
} from "./document-model.js";
import { DOCX_LIMITS, DocxPackageError, type DocxPackageEntry, type DocxPackageReader } from "./docx-package-reader.js";

type XmlNode = Record<string, unknown>;
type XmlValue = unknown;

interface Relationship {
  target: string;
  external: boolean;
}

interface NumberingLevel {
  ordered: boolean;
  marker: string | null;
}

interface NumberingDefinition {
  abstractId: string;
  levels: Map<number, NumberingLevel>;
}

interface StyleDefinition {
  id: string;
  basedOn: string | null;
  paragraph: XmlNode | null;
  run: XmlNode | null;
  name: string | null;
}

interface RunFormatting {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fontSize?: number | null;
  fontFamily?: string | null;
  color?: string | null;
  verticalAlign?: DocumentVerticalAlign;
}

interface ParsedAsset {
  assetId: string;
  entry: DocxPackageEntry;
  mimeType: string;
}

export interface ParsedDocx {
  model: DocumentModel;
  assets: ReadonlyMap<string, ParsedAsset>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  htmlEntities: false,
});
const orderedParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  htmlEntities: false,
  preserveOrder: true,
});

function object(value: XmlValue): XmlNode | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as XmlNode : null;
}

function array(value: XmlValue): XmlNode[] {
  if (Array.isArray(value)) return value.flatMap((item) => object(item) ? [object(item)!] : []);
  const node = object(value);
  return node ? [node] : [];
}

function child(node: XmlNode | null, key: string): XmlNode | null {
  return object(node?.[key]);
}

function children(node: XmlNode | null, key: string): XmlNode[] {
  return array(node?.[key]);
}

function orderedChildren(node: XmlNode | null): Array<[string, XmlNode]> {
  const value = node?.__orderedChildren;
  return Array.isArray(value) ? value as Array<[string, XmlNode]> : Object.entries(node ?? {}).flatMap(([key, value]) => array(value).map((item) => [key, item] as [string, XmlNode]));
}

function normalizeOrderedElement(items: unknown[], initialAttributes?: Record<string, unknown>): XmlNode {
  const result: XmlNode = {};
  if (initialAttributes) Object.assign(result, initialAttributes);
  const order: Array<[string, XmlNode]> = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const attrs = record[":@"] && typeof record[":@"] === "object" ? record[":@"] as Record<string, unknown> : undefined;
    for (const [key, value] of Object.entries(record)) {
      if (key === ":@") continue;
      if (key === "#text") {
        result[key] = value;
        continue;
      }
      const childNode = normalizeOrderedElement(Array.isArray(value) ? value : [], attrs);
      const previous = result[key];
      result[key] = previous === undefined ? childNode : Array.isArray(previous) ? [...previous, childNode] : [previous, childNode];
      order.push([key, childNode]);
    }
  }
  Object.defineProperty(result, "__orderedChildren", { value: order, enumerable: false });
  return result;
}

function attribute(node: XmlNode | null, name: string): string | null {
  const value = node?.[`@_${name}`];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

function text(node: XmlNode | null): string {
  const value = node?.["#text"];
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean").map((item) => String(item)).join("");
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_match, entity: string) => {
    if (entity.toLowerCase() === "amp") return "&";
    if (entity.toLowerCase() === "lt") return "<";
    if (entity.toLowerCase() === "gt") return ">";
    if (entity.toLowerCase() === "quot") return '"';
    if (entity.toLowerCase() === "apos") return "'";
    if (entity.toLowerCase() === "nbsp") return "\u00a0";
    const code = entity.toLowerCase().startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function parseXml(xml: string, label: string): XmlNode {
  try {
    if (XMLValidator.validate(xml) !== true) throw new Error("invalid XML");
    const value = parser.parse(xml) as XmlNode;
    if (!value || typeof value !== "object") throw new Error("empty XML");
    return value;
  } catch {
    throw new DocxPackageError(`DOCX XML part is malformed: ${label}`, "corrupt");
  }
}

function parseOrderedXml(xml: string, label: string): XmlNode {
  try {
    if (XMLValidator.validate(xml) !== true) throw new Error("invalid XML");
    const value = orderedParser.parse(xml) as unknown[];
    if (!Array.isArray(value) || !value.length) throw new Error("empty XML");
    const root = value.find((item) => item && typeof item === "object" && Object.keys(item as object).some((key) => key !== ":@" && key !== "?xml")) as Record<string, unknown> | undefined;
    if (!root) throw new Error("empty XML root");
    const rootName = Object.keys(root).find((key) => key !== ":@" && key !== "?xml");
    if (!rootName || !Array.isArray(root[rootName])) throw new Error("empty XML root");
    const result: XmlNode = {};
    const attributes = root[":@"] && typeof root[":@"] === "object" ? root[":@"] as Record<string, unknown> : undefined;
    result[rootName] = normalizeOrderedElement(root[rootName] as unknown[], attributes);
    return result;
  } catch {
    throw new DocxPackageError(`DOCX XML part is malformed: ${label}`, "corrupt");
  }
}

function twipsToPoints(value: string | null): number {
  const parsed = value === null ? 0 : Number(value);
  return Number.isFinite(parsed) ? parsed / 20 : 0;
}

function emuToPixels(value: string | null): number | null {
  const parsed = value === null ? 0 : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(1600, Math.max(1, Math.round(parsed / 914400 * 96)));
}

function boolProperty(node: XmlNode | null, name: string): boolean | undefined {
  const value = child(node, name);
  if (!value) return undefined;
  const setting = attribute(value, "w:val") ?? attribute(value, "val");
  return setting === null || !["0", "false", "off", "none"].includes(setting.toLowerCase());
}

function mergeFormatting(base: RunFormatting, override: RunFormatting): RunFormatting {
  return { ...base, ...override };
}

function parseRunFormatting(run: XmlNode | null): RunFormatting {
  if (!run) return {};
  const result: RunFormatting = {};
  const bold = boolProperty(run, "w:b");
  const italic = boolProperty(run, "w:i");
  const underlineNode = child(run, "w:u");
  const underlineValue = underlineNode ? attribute(underlineNode, "w:val") ?? attribute(underlineNode, "val") : null;
  const strike = boolProperty(run, "w:strike");
  if (bold !== undefined) result.bold = bold;
  if (italic !== undefined) result.italic = italic;
  if (underlineNode) result.underline = underlineValue !== "none";
  if (strike !== undefined) result.strike = strike;
  const size = attribute(child(run, "w:sz"), "w:val") ?? attribute(child(run, "w:sz"), "val");
  if (size !== null) {
    const points = Number(size) / 2;
    result.fontSize = Number.isFinite(points) && points > 0 && points < 512 ? points : null;
  }
  const fonts = child(run, "w:rFonts");
  const family = attribute(fonts, "w:ascii") ?? attribute(fonts, "w:hAnsi") ?? attribute(fonts, "ascii");
  if (family) result.fontFamily = family;
  const color = attribute(child(run, "w:color"), "w:val") ?? attribute(child(run, "w:color"), "val");
  if (color && color.toLowerCase() !== "auto" && /^[0-9a-f]{6}$/i.test(color)) result.color = `#${color}`;
  const vertical = attribute(child(run, "w:vertAlign"), "w:val") ?? attribute(child(run, "w:vertAlign"), "val");
  if (vertical === "superscript" || vertical === "subscript") result.verticalAlign = vertical;
  return result;
}

function parseParagraphLayout(node: XmlNode | null): Partial<ParagraphLayout> {
  if (!node) return {};
  const alignmentValue = attribute(child(node, "w:jc"), "w:val") ?? attribute(child(node, "w:jc"), "val");
  const alignment: DocumentAlignment | undefined = alignmentValue === "center" || alignmentValue === "right" || alignmentValue === "both" || alignmentValue === "distribute"
    ? alignmentValue === "both" || alignmentValue === "distribute" ? "justified" : alignmentValue
    : alignmentValue === "left" ? "left" : undefined;
  const spacing = child(node, "w:spacing");
  const indent = child(node, "w:ind");
  const firstLine = attribute(indent, "w:firstLine") ?? attribute(indent, "firstLine");
  const hanging = attribute(indent, "w:hanging") ?? attribute(indent, "hanging");
  const before = attribute(spacing, "w:before") ?? attribute(spacing, "before");
  const after = attribute(spacing, "w:after") ?? attribute(spacing, "after");
  const line = attribute(spacing, "w:line") ?? attribute(spacing, "line");
  const left = attribute(indent, "w:left") ?? attribute(indent, "left");
  const right = attribute(indent, "w:right") ?? attribute(indent, "right");
  return {
    ...(alignment ? { alignment } : {}),
    ...(before !== null ? { spacingBeforePt: twipsToPoints(before) } : {}),
    ...(after !== null ? { spacingAfterPt: twipsToPoints(after) } : {}),
    ...(line !== null ? { lineSpacing: (() => {
      const parsed = Number(line);
      return Number.isFinite(parsed) && parsed > 0 ? parsed / 240 : null;
    })() } : {}),
    ...(left !== null ? { indentLeftPt: twipsToPoints(left) } : {}),
    ...(right !== null ? { indentRightPt: twipsToPoints(right) } : {}),
    ...(firstLine !== null ? { firstLineIndentPt: twipsToPoints(firstLine) } : hanging !== null ? { firstLineIndentPt: -twipsToPoints(hanging) } : {}),
  };
}

class DocxStyles {
  private readonly definitions = new Map<string, StyleDefinition>();
  private readonly defaultRun: RunFormatting;

  private constructor(defaultRun: RunFormatting) {
    this.defaultRun = defaultRun;
  }

  static from(reader: DocxPackageReader): DocxStyles {
    if (!reader.has("word/styles.xml")) return new DocxStyles({});
    const root = parseXml(reader.text("word/styles.xml"), "word/styles.xml");
    const styles = child(root, "w:styles");
    const defaults = child(child(styles, "w:docDefaults"), "w:rPrDefault");
    const result = new DocxStyles(parseRunFormatting(child(defaults, "w:rPr")));
    for (const style of children(styles, "w:style")) {
      const id = attribute(style, "w:styleId") ?? attribute(style, "styleId");
      if (!id) continue;
      result.definitions.set(id, {
        id,
        basedOn: attribute(child(style, "w:basedOn"), "w:val") ?? attribute(child(style, "w:basedOn"), "val"),
        paragraph: child(style, "w:pPr"),
        run: child(style, "w:rPr"),
        name: attribute(child(style, "w:name"), "w:val") ?? attribute(child(style, "w:name"), "val"),
      });
    }
    return result;
  }

  run(styleId: string | null): RunFormatting {
    return this.resolve(styleId, new Set()).run;
  }

  paragraph(styleId: string | null): Partial<ParagraphLayout> {
    return parseParagraphLayout(this.resolve(styleId, new Set()).paragraph);
  }

  name(styleId: string | null): string | null {
    return styleId ? this.definitions.get(styleId)?.name ?? null : null;
  }

  private resolve(styleId: string | null, seen: Set<string>): { paragraph: XmlNode | null; run: RunFormatting } {
    if (!styleId || seen.has(styleId)) return { paragraph: null, run: this.defaultRun };
    const definition = this.definitions.get(styleId);
    if (!definition) return { paragraph: null, run: this.defaultRun };
    seen.add(styleId);
    const base = this.resolve(definition.basedOn, seen);
    return {
      paragraph: mergeXml(base.paragraph, definition.paragraph),
      run: mergeFormatting(base.run, parseRunFormatting(definition.run)),
    };
  }
}

function mergeXml(base: XmlNode | null, override: XmlNode | null): XmlNode | null {
  if (!base && !override) return null;
  return { ...base, ...override };
}

class DocxNumbering {
  private readonly nums = new Map<string, NumberingDefinition>();

  static from(reader: DocxPackageReader): DocxNumbering {
    const result = new DocxNumbering();
    if (!reader.has("word/numbering.xml")) return result;
    const root = parseXml(reader.text("word/numbering.xml"), "word/numbering.xml");
    const numbering = child(root, "w:numbering");
    const abstracts = new Map<string, Map<number, NumberingLevel>>();
    for (const abstract of children(numbering, "w:abstractNum")) {
      const abstractId = attribute(abstract, "w:abstractNumId") ?? attribute(abstract, "abstractNumId");
      if (!abstractId) continue;
      const levels = new Map<number, NumberingLevel>();
      for (const level of children(abstract, "w:lvl")) {
        const ilvl = Number(attribute(level, "w:ilvl") ?? attribute(level, "ilvl"));
        if (!Number.isInteger(ilvl) || ilvl < 0 || ilvl > 32) continue;
        const formatNode = child(level, "w:numFmt");
        const formatValue = attribute(formatNode, "w:val") ?? attribute(formatNode, "val") ?? "bullet";
        const marker = attribute(child(level, "w:lvlText"), "w:val") ?? attribute(child(level, "w:lvlText"), "val");
        levels.set(ilvl, { ordered: formatValue !== "bullet", marker: marker ? decodeXmlText(marker) : null });
      }
      abstracts.set(abstractId, levels);
    }
    for (const num of children(numbering, "w:num")) {
      const numId = attribute(num, "w:numId") ?? attribute(num, "numId");
      const abstractId = attribute(child(num, "w:abstractNumId"), "w:val") ?? attribute(child(num, "w:abstractNumId"), "val");
      if (!numId || !abstractId) continue;
      result.nums.set(numId, { abstractId, levels: new Map(abstracts.get(abstractId) ?? []) });
    }
    return result;
  }

  level(numId: string | null, ilvl: number): NumberingLevel | null {
    if (!numId) return null;
    const definition = this.nums.get(numId);
    if (!definition) return null;
    return definition.levels.get(ilvl) ?? definition.levels.get(0) ?? null;
  }
}

function parseRelationships(reader: DocxPackageReader): Map<string, Relationship> {
  const result = new Map<string, Relationship>();
  const path = "word/_rels/document.xml.rels";
  if (!reader.has(path)) return result;
  const root = parseXml(reader.text(path), path);
  const relationships = child(root, "Relationships");
  for (const relation of children(relationships, "Relationship")) {
    const id = attribute(relation, "Id");
    const target = attribute(relation, "Target");
    if (!id || !target) continue;
    result.set(id, { target, external: (attribute(relation, "TargetMode") ?? "").toLowerCase() === "external" });
  }
  return result;
}

function relationshipUrl(reader: DocxPackageReader, relationships: Map<string, Relationship>, id: string | null): string | null {
  if (!id) return null;
  const relationship = relationships.get(id);
  if (!relationship?.external) return null;
  try {
    const url = new URL(relationship.target);
    return ["http:", "https:", "mailto:"].includes(url.protocol.toLowerCase()) ? url.toString() : null;
  } catch {
    return null;
  }
}

function mimeForEntry(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  return extension === "png" ? "image/png"
    : extension === "jpg" || extension === "jpeg" ? "image/jpeg"
      : extension === "gif" ? "image/gif"
        : extension === "webp" ? "image/webp"
            : "application/octet-stream";
}

function findDescendant(node: XmlNode | null, key: string): XmlNode | null {
  if (!node) return null;
  if (node[key]) return object(node[key]);
  for (const value of Object.values(node)) {
    const childNode = object(value);
    if (!childNode) continue;
    const found = findDescendant(childNode, key);
    if (found) return found;
  }
  return null;
}

function unsupportedBlock(id: string, label: string): UnsupportedBlock {
  return { type: "unsupported", id, label };
}

export class DocxParser {
  private readonly styles: DocxStyles;
  private readonly numbering: DocxNumbering;
  private readonly relationships: Map<string, Relationship>;
  private readonly assets = new Map<string, ParsedAsset>();
  private nextAsset = 1;
  private warnings = 0;

  private constructor(private readonly reader: DocxPackageReader) {
    this.styles = DocxStyles.from(reader);
    this.numbering = DocxNumbering.from(reader);
    this.relationships = parseRelationships(reader);
  }

  static parse(reader: DocxPackageReader, assetUrl?: (assetId: string) => string): ParsedDocx {
    const parser = new DocxParser(reader);
    const root = parseOrderedXml(reader.text("word/document.xml"), "word/document.xml");
    const body = child(child(root, "w:document"), "w:body");
    if (!body) throw new DocxPackageError("DOCX document body is missing", "corrupt");
    const blocks = parser.parseBlocks(body, "b", 0);
    const model: DocumentModel = { version: 1, blocks };
    if (assetUrl) parser.attachAssetUrls(model, assetUrl);
    return { model, assets: parser.assets };
  }

  private parseBlocks(parent: XmlNode | null, prefix: string, tableDepth: number): DocumentBlock[] {
    const blocks: DocumentBlock[] = [];
    let index = 0;
    for (const key of ["w:p", "w:tbl"]) {
      void key;
    }
    const entries = orderedChildren(parent);
    for (const [key, value] of entries) {
      if (key === "w:sectPr") continue;
      if (key === "w:p") {
        blocks.push(this.parseParagraph(value, `${prefix}-p${++index}`));
      } else if (key === "w:tbl") {
        blocks.push(tableDepth > 1 ? unsupportedBlock(`${prefix}-t${++index}`, "Nested table") : this.parseTable(value, `${prefix}-t${++index}`, tableDepth));
      }
      if (blocks.length > DOCX_LIMITS.maxDocumentBlocks) throw new DocxPackageError("DOCX document contains too many blocks", "resource-limit");
    }
    return blocks;
  }

  private parseParagraph(paragraph: XmlNode, id: string): DocumentBlock {
    const properties = child(paragraph, "w:pPr");
    const styleId = attribute(child(properties, "w:pStyle"), "w:val") ?? attribute(child(properties, "w:pStyle"), "val");
    const styleLayout = this.styles.paragraph(styleId);
    const directLayout = parseParagraphLayout(properties);
    const layout: ParagraphLayout = {
      alignment: directLayout.alignment ?? styleLayout.alignment ?? "left",
      spacingBeforePt: directLayout.spacingBeforePt ?? styleLayout.spacingBeforePt ?? 0,
      spacingAfterPt: directLayout.spacingAfterPt ?? styleLayout.spacingAfterPt ?? 0,
      lineSpacing: directLayout.lineSpacing ?? styleLayout.lineSpacing ?? null,
      indentLeftPt: directLayout.indentLeftPt ?? styleLayout.indentLeftPt ?? 0,
      indentRightPt: directLayout.indentRightPt ?? styleLayout.indentRightPt ?? 0,
      firstLineIndentPt: directLayout.firstLineIndentPt ?? styleLayout.firstLineIndentPt ?? 0,
    };
    const content: DocumentInline[] = [];
    let runIndex = 0;
    let imageIndex = 0;
    for (const [key, value] of orderedChildren(paragraph)) {
      if (key === "w:pPr") continue;
      if (key === "w:r") {
        content.push(...this.parseRun(value, `${id}-r${++runIndex}`, styleId, null));
      } else if (key === "w:hyperlink") {
        const href = relationshipUrl(this.reader, this.relationships, attribute(value, "r:id"));
        for (const run of children(value, "w:r")) {
          content.push(...this.parseRun(run, `${id}-r${++runIndex}`, styleId, href));
        }
      } else if (key === "w:drawing") {
        const image = this.parseDrawing(value, `${id}-i${++imageIndex}`);
        if (image) content.push(image);
      } else if (["w:bookmarkStart", "w:bookmarkEnd", "w:proofErr", "w:permStart", "w:permEnd", "w:commentRangeStart", "w:commentRangeEnd"].includes(key)) {
        continue;
      } else if (["w:ins", "w:del", "w:fldSimple", "w:object", "w:pict", "w:txbxContent"].includes(key)) {
        this.warnings += 1;
      }
    }
    const numPr = child(properties, "w:numPr");
    const numId = attribute(child(numPr, "w:numId"), "w:val") ?? attribute(child(numPr, "w:numId"), "val");
    const level = Number(attribute(child(numPr, "w:ilvl"), "w:val") ?? attribute(child(numPr, "w:ilvl"), "val") ?? "0");
    const numbering = this.numbering.level(numId, Number.isInteger(level) && level >= 0 ? level : 0);
    if (numbering) {
      const list: ListItemBlock = { type: "list-item", id, styleId: styleId ?? null, content, level: Math.min(32, Math.max(0, level)), ordered: numbering.ordered, marker: numbering.marker, ...layout };
      return list;
    }
    const headingLevel = this.headingLevel(styleId);
    if (headingLevel !== null) {
      const heading: HeadingBlock = { type: "heading", id, styleId: styleId ?? null, content, level: headingLevel, ...layout };
      return heading;
    }
    if (content.length === 1 && content[0]?.kind === "image") {
      const image = content[0];
      const block: ImageBlock = { type: "image", id, assetId: image.assetId, altText: image.altText, widthPx: image.widthPx, heightPx: image.heightPx };
      return block;
    }
    const block: ParagraphBlock = { type: "paragraph", id, styleId: styleId ?? null, content, ...layout };
    return block;
  }

  private parseRun(run: XmlNode, id: string, styleId: string | null, href: string | null): DocumentInline[] {
    const formatting = mergeFormatting(this.styles.run(styleId), parseRunFormatting(child(run, "w:rPr")));
    const parts: string[] = [];
    const appendText = (value: string) => parts.push(decodeXmlText(value));
    for (const [key, value] of orderedChildren(run)) {
      if (key === "w:rPr") continue;
      if (key === "w:t" || key === "w:delText") {
        appendText(text(value));
      } else if (key === "w:tab") {
        parts.push("\t");
      } else if (key === "w:br" || key === "w:cr") {
        parts.push("\n");
      } else if (key === "w:noBreakHyphen") {
        parts.push("‑");
      }
    }
    if (!parts.length) return [];
    const result: TextRun = {
      kind: "text",
      id,
      text: parts.join(""),
      bold: formatting.bold ?? false,
      italic: formatting.italic ?? false,
      underline: formatting.underline ?? false,
      strike: formatting.strike ?? false,
      fontSize: formatting.fontSize ?? null,
      fontFamily: formatting.fontFamily ?? null,
      color: formatting.color ?? null,
      verticalAlign: formatting.verticalAlign ?? "baseline",
      link: href ? { href } : null,
    };
    return [result];
  }

  private parseDrawing(drawing: XmlNode, id: string): InlineImage | null {
    const blip = findDescendant(drawing, "a:blip");
    const relationId = attribute(blip, "r:embed");
    const relation = relationId ? this.relationships.get(relationId) : null;
    const target = relation && !relation.external ? this.reader.resolveTarget("word/document.xml", relation.target) : null;
    const entry = target ? this.reader.entry(target) : null;
    if (!entry) {
      this.warnings += 1;
      return null;
    }
    const assetId = `asset-${this.nextAsset++}`;
    const extent = findDescendant(drawing, "wp:extent");
    const docPr = findDescendant(drawing, "wp:docPr");
    const asset: ParsedAsset = { assetId, entry, mimeType: mimeForEntry(entry.path) };
    this.assets.set(assetId, asset);
    return {
      kind: "image",
      id,
      assetId,
      altText: attribute(docPr, "descr") ?? attribute(docPr, "name"),
      widthPx: emuToPixels(attribute(extent, "cx")),
      heightPx: emuToPixels(attribute(extent, "cy")),
    };
  }

  private parseTable(table: XmlNode, id: string, tableDepth: number): TableBlock {
    const grid = child(table, "w:tblGrid");
    const columnWidthsPx = children(grid, "w:gridCol").map((column) => {
      const width = twipsToPoints(attribute(column, "w:w") ?? attribute(column, "w"));
      return width > 0 ? Math.round(width * 96 / 72) : null;
    });
    const rows: TableRow[] = [];
    let rowIndex = 0;
    for (const row of children(table, "w:tr")) {
      const cells: TableCell[] = [];
      let cellIndex = 0;
      for (const cell of children(row, "w:tc")) {
        const properties = child(cell, "w:tcPr");
        const widthTwips = attribute(child(properties, "w:tcW"), "w:w") ?? attribute(child(properties, "w:tcW"), "w");
        const shading = child(properties, "w:shd");
        const borders = this.parseBorders(child(properties, "w:tcBorders"));
        const blocks = this.parseBlocks(cell, `${id}-r${rowIndex + 1}-c${cellIndex + 1}`, tableDepth + 1);
        cells.push({
          id: `${id}-r${rowIndex + 1}-c${++cellIndex}`,
          blocks: blocks.length ? blocks : [{ type: "paragraph", id: `${id}-r${rowIndex + 1}-c${cellIndex}-empty`, styleId: null, content: [], alignment: "left", spacingBeforePt: 0, spacingAfterPt: 0, lineSpacing: null, indentLeftPt: 0, indentRightPt: 0, firstLineIndentPt: 0 }],
          widthPx: widthTwips ? Math.round(twipsToPoints(widthTwips) * 96 / 72) : null,
          backgroundColor: (() => { const fill = attribute(shading, "w:fill") ?? attribute(shading, "fill"); return fill && /^[0-9a-f]{6}$/i.test(fill) ? `#${fill}` : null; })(),
          borders,
        });
      }
      rows.push({ id: `${id}-r${++rowIndex}`, cells });
    }
    return { type: "table", id, rows, columnWidthsPx };
  }

  private parseBorders(node: XmlNode | null): TableCell["borders"] {
    const result: TableCell["borders"] = {};
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const border = child(node, `w:${side}`);
      if (!border) continue;
      const color = attribute(border, "w:color") ?? attribute(border, "color");
      const size = attribute(border, "w:sz") ?? attribute(border, "sz");
      const width = size === null ? null : Number(size) / 8;
      const value: TableBorder = {
        style: attribute(border, "w:val") ?? attribute(border, "val"),
        color: color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : null,
        widthPt: Number.isFinite(width) ? width : null,
      };
      result[side] = value;
    }
    return result;
  }

  private headingLevel(styleId: string | null): number | null {
    if (!styleId) return null;
    const label = `${styleId} ${this.styles.name(styleId) ?? ""}`.toLowerCase();
    const match = /(?:^|\s|-)heading\s*([1-9][0-9]*)/.exec(label);
    if (!match) return null;
    return Math.min(9, Number(match[1]));
  }

  private attachAssetUrls(model: DocumentModel, assetUrl: (assetId: string) => string): void {
    const visit = (block: DocumentBlock): void => {
      if (block.type === "image") block.src = assetUrl(block.assetId);
      if (block.type === "paragraph" || block.type === "heading" || block.type === "list-item") {
        for (const inline of block.content) if (inline.kind === "image") inline.src = assetUrl(inline.assetId);
      }
      if (block.type === "table") for (const row of block.rows) for (const cell of row.cells) for (const nested of cell.blocks) visit(nested);
    };
    for (const block of model.blocks) visit(block);
  }
}
