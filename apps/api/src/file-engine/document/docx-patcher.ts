import { XMLValidator } from "fast-xml-parser";
import { zipSync } from "fflate";
import type { DocumentBlock, DocumentModel, TextRun } from "./document-model.js";
import {
  DOCUMENT_EDIT_LIMITS,
  DocumentEditValidationError,
  type DocumentBlockPatch,
  type DocumentParagraphStyle,
  type DocumentPatchRequest,
} from "./document-edit.types.js";
import { DocxPackageReader } from "./docx-package-reader.js";
import { DocxParser } from "./docx-parser.js";
import { createDocxSourceMap, findDocumentBlock, type DocxParagraphSource, type SourceNode } from "./docx-source-map.js";

interface Replacement {
  start: number;
  end: number;
  value: string;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function attributeValue(attributes: string, names: readonly string[]): string | null {
  for (const name of names) {
    const match = new RegExp(`(?:^|\\s)${name.replace(":", "\\:")}\\s*=\\s*(["'])(.*?)\\1`, "u").exec(attributes);
    if (match?.[2] !== undefined) return match[2];
  }
  return null;
}

function paragraphStyles(reader: DocxPackageReader): Map<DocumentParagraphStyle, string> {
  const result = new Map<DocumentParagraphStyle, string>();
  if (!reader.has("word/styles.xml")) return result;
  const xml = reader.text("word/styles.xml");
  const stylePattern = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/giu;
  for (const match of xml.matchAll(stylePattern)) {
    const attributes = match[1] ?? "";
    if (attributeValue(attributes, ["w:type", "type"]) !== "paragraph") continue;
    const styleId = attributeValue(attributes, ["w:styleId", "styleId"]);
    if (!styleId) continue;
    const nameNode = /<w:name\b([^>]*)>/iu.exec(match[2] ?? "");
    const name = nameNode ? attributeValue(nameNode[1] ?? "", ["w:val", "val"]) : null;
    const label = `${styleId} ${name ?? ""}`.toLowerCase();
    const heading = /(?:^|[\s_-])heading\s*([1-3])(?:$|[\s_-])/u.exec(label);
    if (heading) {
      const semantic = `heading-${heading[1]}` as DocumentParagraphStyle;
      if (!result.has(semantic)) result.set(semantic, styleId);
    }
    if (/^(?:normal|default paragraph font)($|\s)/u.test(label) && !result.has("normal")) result.set("normal", styleId);
  }
  return result;
}

function applyReplacements(source: string, replacements: Replacement[]): string {
  return [...replacements].sort((left, right) => right.start - left.start).reduce(
    (current, replacement) => current.slice(0, replacement.start) + replacement.value + current.slice(replacement.end),
    source,
  );
}

function directChild(node: SourceNode | null, name: string): SourceNode | null {
  return node?.children.find((child) => child.name === name) ?? null;
}

function styleForPatch(reader: DocxPackageReader, style: DocumentParagraphStyle): string | null {
  if (style === "preserve") return null;
  if (style === "normal") return paragraphStyles(reader).get("normal") ?? null;
  const resolved = paragraphStyles(reader).get(style);
  if (!resolved) throw new DocumentEditValidationError(`The requested paragraph style is unavailable: ${style}`);
  return resolved;
}

function patchParagraphProperties(
  xml: string,
  source: DocxParagraphSource,
  reader: DocxPackageReader,
  patch: DocumentBlockPatch,
  current: Extract<DocumentBlock, { type: "paragraph" | "heading" | "list-item" }>,
): string {
  const styleChanged = patch.style !== "preserve" && patch.style !== semanticStyle(current);
  const alignmentChanged = patch.alignment !== current.alignment;
  if (!styleChanged && !alignmentChanged) return source.pPr ? xml.slice(source.pPr.start, source.pPr.end) : "";
  const childReplacements: Replacement[] = [];
  const pPr = source.pPr;
  const styleId = styleChanged ? styleForPatch(reader, patch.style) : undefined;
  const alignment = alignmentChanged ? patch.alignment : undefined;
  if (!pPr) {
    const children = [
      styleId === undefined || styleId === null ? "" : `<w:pStyle w:val="${escapeXml(styleId)}"/>`,
      alignment === undefined ? "" : `<w:jc w:val="${alignment === "justified" ? "both" : alignment}"/>`,
    ].join("");
    return children ? `<w:pPr>${children}</w:pPr>` : "";
  }
  const pPrRaw = xml.slice(pPr.start, pPr.end);
  const patchElement = (name: string, value: string | null | undefined): void => {
    if (value === undefined) return;
    const currentElement = directChild(pPr, name);
    const relative = (position: number) => position - pPr.start;
    if (currentElement) {
      childReplacements.push({
        start: relative(currentElement.start),
        end: relative(currentElement.end),
        value: value === null ? "" : value,
      });
      return;
    }
    if (value !== null) childReplacements.push({ start: relative(pPr.closeStart), end: relative(pPr.closeStart), value });
  };
  patchElement("w:pStyle", styleId === undefined ? undefined : styleId === null ? "" : `<w:pStyle w:val="${escapeXml(styleId)}"/>`);
  patchElement("w:jc", alignment === undefined ? undefined : `<w:jc w:val="${alignment === "justified" ? "both" : alignment}"/>`);
  return applyReplacements(pPrRaw, childReplacements);
}

function semanticStyle(block: Extract<DocumentBlock, { type: "paragraph" | "heading" | "list-item" }>): DocumentParagraphStyle {
  if (block.type === "heading" && block.level >= 1 && block.level <= 3) return `heading-${block.level}` as DocumentParagraphStyle;
  if (block.type === "paragraph" && block.styleId === null) return "normal";
  return "preserve";
}

function runProperties(run: Pick<TextRun, "bold" | "italic" | "underline" | "strike" | "fontSize" | "fontFamily" | "color" | "verticalAlign">): string {
  const children = [
    run.bold ? "<w:b/>" : "<w:b w:val=\"0\"/>",
    run.italic ? "<w:i/>" : "<w:i w:val=\"0\"/>",
    run.underline ? "<w:u w:val=\"single\"/>" : "<w:u w:val=\"none\"/>",
    run.strike ? "<w:strike/>" : "<w:strike w:val=\"0\"/>",
    run.fontSize === null ? "" : `<w:sz w:val="${Math.round(run.fontSize * 2)}"/>`,
    run.fontFamily === null ? "" : `<w:rFonts w:ascii="${escapeXml(run.fontFamily)}" w:hAnsi="${escapeXml(run.fontFamily)}"/>`,
    run.color === null ? "" : `<w:color w:val="${run.color.slice(1)}"/>`,
    run.verticalAlign === "baseline" ? "" : `<w:vertAlign w:val="${run.verticalAlign}"/>`,
  ].join("");
  return children ? `<w:rPr>${children}</w:rPr>` : "";
}

function serializeRun(run: Pick<TextRun, "text" | "link" | "bold" | "italic" | "underline" | "strike" | "fontSize" | "fontFamily" | "color" | "verticalAlign">): string {
  if (run.link) throw new DocumentEditValidationError("Hyperlink editing is not supported");
  const children: string[] = [];
  let text = "";
  const flushText = () => {
    if (!text) return;
    const preserve = /^\s/u.test(text) || /\s$/u.test(text) || / {2,}/u.test(text);
    children.push(`<w:t${preserve ? " xml:space=\"preserve\"" : ""}>${escapeXml(text)}</w:t>`);
    text = "";
  };
  for (const character of run.text) {
    if (character === "\t") {
      flushText();
      children.push("<w:tab/>");
    } else if (character === "\n" || character === "\r") {
      flushText();
      children.push("<w:br/>");
    } else {
      text += character;
    }
  }
  flushText();
  if (!children.length) return "";
  return `<w:r>${runProperties(run)}${children.join("")}</w:r>`;
}

function serializeRuns(content: Array<Pick<TextRun, "text" | "link" | "bold" | "italic" | "underline" | "strike" | "fontSize" | "fontFamily" | "color" | "verticalAlign">>): string {
  return content.map(serializeRun).join("");
}

function blocksById(model: DocumentModel, ids: readonly string[]): Map<string, DocumentBlock> {
  const result = new Map<string, DocumentBlock>();
  for (const id of ids) {
    const block = findDocumentBlock(model, id);
    if (block) result.set(id, block);
  }
  return result;
}

function validateBlockPatch(patch: DocumentBlockPatch, current: DocumentBlock, source: DocxParagraphSource): asserts current is Extract<DocumentBlock, { type: "paragraph" | "heading" | "list-item" }> {
  if (!source.editable) throw new DocumentEditValidationError("This paragraph contains unsupported content and is read-only");
  if (current.type !== "paragraph" && current.type !== "heading" && current.type !== "list-item") throw new DocumentEditValidationError("This block is not editable");
  if (current.type === "list-item" && patch.type !== "list-item") throw new DocumentEditValidationError("List structure cannot be changed");
  if (patch.type === "list-item" && current.type !== "list-item") throw new DocumentEditValidationError("List structure cannot be changed");
  if (current.type === "list-item" && patch.style !== "preserve" && patch.style !== "normal") throw new DocumentEditValidationError("List styles cannot be changed");
}

export interface PatchedDocx {
  bytes: Buffer;
  model: DocumentModel;
}

export class DocxPatcher {
  static apply(sourceBytes: Uint8Array, request: DocumentPatchRequest): PatchedDocx {
    const reader = DocxPackageReader.fromBytes(sourceBytes);
    const xml = reader.text("word/document.xml");
    if (XMLValidator.validate(xml) !== true) throw new DocumentEditValidationError("The DOCX document part is malformed");
    let sourceMap: ReadonlyMap<string, DocxParagraphSource>;
    try {
      sourceMap = createDocxSourceMap(xml);
    } catch {
      throw new DocumentEditValidationError("The DOCX document source mapping is invalid");
    }
    const original = DocxParser.parse(reader).model;
    const currentBlocks = blocksById(original, request.blocks.map((block) => block.blockId));
    const replacements: Replacement[] = [];
    for (const patch of request.blocks) {
      const source = sourceMap.get(patch.blockId);
      const current = currentBlocks.get(patch.blockId);
      if (!source || !current) throw new DocumentEditValidationError("The document block no longer exists");
      validateBlockPatch(patch, current, source);
      const pPr = patchParagraphProperties(xml, source, reader, patch, current);
      replacements.push({
        start: source.node.openEnd,
        end: source.node.closeStart,
        value: `${pPr}${serializeRuns(patch.content)}`,
      });
    }
    const documentXml = applyReplacements(xml, replacements);
    const entries: Record<string, Uint8Array> = {};
    for (const [path, value] of reader.allEntries()) entries[path] = value;
    entries["word/document.xml"] = new TextEncoder().encode(documentXml);
    const bytes = Buffer.from(zipSync(entries));
    const savedReader = DocxPackageReader.fromBytes(bytes);
    const model = DocxParser.parse(savedReader).model;
    return { bytes, model };
  }

  static assertWithinLimits(request: DocumentPatchRequest): void {
    if (request.blocks.length > DOCUMENT_EDIT_LIMITS.maxChangedBlocks) throw new DocumentEditValidationError("Too many changed blocks");
  }
}

export function documentBlockText(block: DocumentBlock): string {
  if (block.type !== "paragraph" && block.type !== "heading" && block.type !== "list-item") return "";
  return block.content.filter((inline): inline is TextRun => inline.kind === "text").map((inline) => inline.text).join("");
}
