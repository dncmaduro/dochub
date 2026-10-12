import type { DocumentAlignment, DocumentBlock, DocumentModel } from "../api";
import { replaceText, setFontSize, toggleFormatting, type EditableDocumentBlock, type InlineFormat } from "./run-utils";

export type DocumentCommand =
  | { type: "replace-text"; blockId: string; start: number; end: number; text: string }
  | { type: "toggle-format"; blockId: string; start: number; end: number; format: InlineFormat }
  | { type: "set-font-size"; blockId: string; start: number; end: number; fontSize: number | null }
  | { type: "set-alignment"; blockId: string; alignment: DocumentAlignment }
  | { type: "set-style"; blockId: string; style: "normal" | "heading-1" | "heading-2" | "heading-3" };

function updateBlock(blocks: DocumentBlock[], id: string, update: (block: EditableDocumentBlock) => DocumentBlock): [DocumentBlock[], boolean] {
  let changed = false;
  const next = blocks.map((block) => {
    if (block.id === id && (block.type === "paragraph" || block.type === "heading" || block.type === "list-item")) {
      changed = true;
      return update(block);
    }
    if (block.type === "table") {
      const rows = block.rows.map((row) => ({ ...row, cells: row.cells.map((cell) => {
        const [nested, nestedChanged] = updateBlock(cell.blocks, id, update);
        changed ||= nestedChanged;
        return nestedChanged ? { ...cell, blocks: nested } : cell;
      }) }));
      return changed ? { ...block, rows } : block;
    }
    return block;
  });
  return [next, changed];
}

function updateModel(model: DocumentModel, id: string, update: (block: EditableDocumentBlock) => DocumentBlock): DocumentModel {
  const [blocks] = updateBlock(model.blocks, id, update);
  return { ...model, blocks };
}

function blockStyle(block: EditableDocumentBlock, style: "normal" | "heading-1" | "heading-2" | "heading-3"): EditableDocumentBlock {
  if (style === "normal") return { ...block, type: "paragraph", styleId: null };
  const level = Number(style.slice(-1));
  return { ...block, type: "heading", level, styleId: block.styleId ?? `Heading${level}` };
}

export function executeCommand(model: DocumentModel, command: DocumentCommand): DocumentModel {
  switch (command.type) {
    case "replace-text":
      return updateModel(model, command.blockId, (block) => replaceText(block, command.start, command.end, command.text));
    case "toggle-format":
      return updateModel(model, command.blockId, (block) => toggleFormatting(block, command.start, command.end, command.format));
    case "set-font-size":
      return updateModel(model, command.blockId, (block) => setFontSize(block, command.start, command.end, command.fontSize));
    case "set-alignment":
      return updateModel(model, command.blockId, (block) => ({ ...block, alignment: command.alignment }));
    case "set-style":
      return updateModel(model, command.blockId, (block) => blockStyle(block, command.style));
  }
}

