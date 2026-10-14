import type { DocumentBlock, DocumentModel } from "./document-model.js";

export interface SourceNode {
  name: string;
  attributes: string;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  children: SourceNode[];
}

export interface DocxParagraphSource {
  id: string;
  node: SourceNode;
  pPr: SourceNode | null;
  editable: boolean;
  readonlyReason?: string;
}

const SAFE_PARAGRAPH_CHILDREN = new Set(["w:pPr", "w:r"]);
const SAFE_PARAGRAPH_PROPERTIES = new Set(["w:pStyle", "w:numPr", "w:jc", "w:spacing", "w:ind"]);
const SAFE_RUN_CHILDREN = new Set(["w:rPr", "w:t", "w:tab", "w:br"]);
const SAFE_RUN_PROPERTIES = new Set(["w:b", "w:i", "w:u", "w:strike", "w:sz", "w:rFonts", "w:color", "w:vertAlign"]);

function significantChildren(node: SourceNode): SourceNode[] {
  return node.children.filter((child) => !child.name.startsWith("#"));
}

function attributeNames(value: string): Set<string> {
  const result = new Set<string>();
  for (const match of value.matchAll(/([a-z_][a-z0-9:_.-]*)\s*=\s*["']/giu)) result.add(match[1] ?? "");
  return result;
}

function hasOnlyAttributes(node: SourceNode, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return [...attributeNames(node.attributes)].every((name) => allowedSet.has(name));
}

function classifyParagraph(node: SourceNode): { editable: boolean; reason?: string } {
  for (const child of significantChildren(node)) {
    if (!SAFE_PARAGRAPH_CHILDREN.has(child.name)) {
      return { editable: false, reason: "unsupported-inline-content" };
    }
    if (child.name === "w:pPr") {
      if (child.attributes.trim()) return { editable: false, reason: "unsupported-paragraph-attribute" };
      for (const property of significantChildren(child)) {
        if (!SAFE_PARAGRAPH_PROPERTIES.has(property.name)) {
          return { editable: false, reason: "unsupported-paragraph-property" };
        }
        if (property.name === "w:pStyle" && !hasOnlyAttributes(property, ["w:val", "val"])) return { editable: false, reason: "unsupported-style-property" };
        if (property.name === "w:jc" && !hasOnlyAttributes(property, ["w:val", "val"])) return { editable: false, reason: "unsupported-alignment-property" };
        if (property.name === "w:numPr") {
          for (const numberingProperty of significantChildren(property)) {
            if (numberingProperty.name !== "w:ilvl" && numberingProperty.name !== "w:numId") {
              return { editable: false, reason: "unsupported-numbering-property" };
            }
            if (!hasOnlyAttributes(numberingProperty, ["w:val", "val"])) return { editable: false, reason: "unsupported-numbering-attribute" };
          }
        }
      }
    }
    if (child.name === "w:r") {
      if (child.attributes.trim()) return { editable: false, reason: "unsupported-run-attribute" };
      for (const runChild of significantChildren(child)) {
        if (!SAFE_RUN_CHILDREN.has(runChild.name)) {
          return { editable: false, reason: "unsupported-run-content" };
        }
        if (runChild.name === "w:rPr") {
          if (runChild.attributes.trim()) return { editable: false, reason: "unsupported-run-property-attribute" };
          for (const property of significantChildren(runChild)) {
            if (!SAFE_RUN_PROPERTIES.has(property.name)) {
              return { editable: false, reason: "unsupported-run-property" };
            }
            const allowed = property.name === "w:rFonts" ? ["w:ascii", "w:hAnsi", "ascii", "hAnsi"]
              : property.name === "w:u" ? ["w:val", "val"]
                : ["w:val", "val"];
            if (!hasOnlyAttributes(property, allowed)) return { editable: false, reason: "unsupported-run-attribute" };
            if (property.name === "w:u") {
              const value = /(?:w:val|val)\s*=\s*(["'])(.*?)\1/iu.exec(property.attributes)?.[2];
              if (value && value !== "single" && value !== "none") return { editable: false, reason: "unsupported-underline-style" };
            }
          }
        }
        if (runChild.name === "w:t" && !hasOnlyAttributes(runChild, ["xml:space"])) return { editable: false, reason: "unsupported-text-attribute" };
        if ((runChild.name === "w:tab" || runChild.name === "w:br") && runChild.attributes.trim()) return { editable: false, reason: "unsupported-break-attribute" };
      }
    }
  }
  return { editable: true };
}

function readTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  throw new Error("Unterminated XML tag");
}

function parseSourceTree(xml: string): SourceNode {
  const roots: SourceNode[] = [];
  const stack: SourceNode[] = [];
  let index = 0;
  while (index < xml.length) {
    const open = xml.indexOf("<", index);
    if (open < 0) break;
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0) throw new Error("Unterminated XML comment");
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      if (end < 0) throw new Error("Unterminated XML CDATA");
      index = end + 3;
      continue;
    }
    const end = readTagEnd(xml, open);
    const body = xml.slice(open + 1, end - 1).trim();
    if (!body || body.startsWith("?") || body.startsWith("!")) {
      index = end;
      continue;
    }
    if (body.startsWith("/")) {
      const name = body.slice(1).trim().split(/\s+/u)[0];
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error("Mismatched XML tags");
      node.closeStart = open;
      node.end = end;
      index = end;
      continue;
    }
    const selfClosing = /\/\s*$/u.test(body);
    const tagBody = body.replace(/\/\s*$/u, "").trim();
    const name = tagBody.split(/\s+/u)[0];
    if (!name) throw new Error("XML element has no name");
    const node: SourceNode = {
      name,
      attributes: tagBody.slice(name.length),
      start: open,
      openEnd: end,
      closeStart: selfClosing ? end : -1,
      end,
      children: [],
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (!selfClosing) stack.push(node);
    index = end;
  }
  if (stack.length || roots.length !== 1) throw new Error("Invalid XML source tree");
  return roots[0];
}

function findChild(node: SourceNode, name: string): SourceNode | null {
  return significantChildren(node).find((child) => child.name === name) ?? null;
}

function visitBlocks(parent: SourceNode, prefix: string, tableDepth: number, result: Map<string, DocxParagraphSource>): void {
  let index = 0;
  for (const child of significantChildren(parent)) {
    if (child.name === "w:p") {
      const id = `${prefix}-p${++index}`;
      const classification = classifyParagraph(child);
      result.set(id, {
        id,
        node: child,
        pPr: findChild(child, "w:pPr"),
        ...classification,
      });
    } else if (child.name === "w:tbl") {
      const tableId = `${prefix}-t${++index}`;
      if (tableDepth > 1) continue;
      let rowIndex = 0;
      for (const row of significantChildren(child).filter((value) => value.name === "w:tr")) {
        rowIndex += 1;
        let cellIndex = 0;
        for (const cell of significantChildren(row).filter((value) => value.name === "w:tc")) {
          cellIndex += 1;
          visitBlocks(cell, `${tableId}-r${rowIndex}-c${cellIndex}`, tableDepth + 1, result);
        }
      }
    }
  }
}

export function createDocxSourceMap(xml: string): ReadonlyMap<string, DocxParagraphSource> {
  const root = parseSourceTree(xml);
  const body = findChild(root, "w:body");
  if (!body) throw new Error("DOCX document body is missing");
  const result = new Map<string, DocxParagraphSource>();
  visitBlocks(body, "b", 0, result);
  return result;
}

function visitModelBlocks(blocks: DocumentBlock[], sourceMap: ReadonlyMap<string, DocxParagraphSource>): boolean {
  let editable = false;
  for (const block of blocks) {
    if (block.type === "paragraph" || block.type === "heading" || block.type === "list-item") {
      const source = sourceMap.get(block.id);
      block.editable = source?.editable ?? false;
      if (!source?.editable) block.readonlyReason = source?.readonlyReason ?? "source-mapping-unavailable";
      editable ||= Boolean(block.editable);
    } else if (block.type === "table") {
      for (const row of block.rows) for (const cell of row.cells) {
        if (visitModelBlocks(cell.blocks, sourceMap)) editable = true;
      }
    } else {
      block.editable = false;
    }
  }
  return editable;
}

export function annotateDocumentModel(model: DocumentModel, sourceMap: ReadonlyMap<string, DocxParagraphSource>): void {
  model.editable = visitModelBlocks(model.blocks, sourceMap);
}

export function findDocumentBlock(model: DocumentModel, id: string): DocumentBlock | null {
  const visit = (blocks: DocumentBlock[]): DocumentBlock | null => {
    for (const block of blocks) {
      if (block.id === id) return block;
      if (block.type === "table") {
        for (const row of block.rows) for (const cell of row.cells) {
          const found = visit(cell.blocks);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return visit(model.blocks);
}
