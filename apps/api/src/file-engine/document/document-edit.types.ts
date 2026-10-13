import type { DocumentAlignment, DocumentVerticalAlign } from "./document-model.js";

export type DocumentParagraphStyle = "preserve" | "normal" | "heading-1" | "heading-2" | "heading-3";

export interface DocumentTextRunPatch {
  kind: "text";
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fontSize: number | null;
  fontFamily: string | null;
  color: string | null;
  verticalAlign: DocumentVerticalAlign;
  link: null;
}

export interface DocumentBlockPatch {
  blockId: string;
  type: "paragraph" | "heading" | "list-item";
  style: DocumentParagraphStyle;
  alignment: DocumentAlignment;
  content: DocumentTextRunPatch[];
}

export interface DocumentPatchRequest {
  expectedRevision: string;
  blocks: DocumentBlockPatch[];
  operationId?: string;
}

export const DOCUMENT_EDIT_LIMITS = {
  maxChangedBlocks: 100,
  maxRunsPerBlock: 500,
  maxTextPerBlock: 100_000,
  maxPayloadBytes: 2 * 1024 * 1024,
  maxFontFamilyLength: 100,
} as const;

export class DocumentEditValidationError extends Error {
  readonly code = "DOCUMENT_EDIT_INVALID";
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringValue(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) throw new DocumentEditValidationError(`Invalid ${label}`);
  return value;
}

function nullableString(value: unknown, label: string, maxLength: number): string | null {
  if (value === null) return null;
  return stringValue(value, label, maxLength);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new DocumentEditValidationError(`Invalid ${label}`);
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new DocumentEditValidationError(`Invalid ${label}`);
  return value as T;
}

function textRun(value: unknown): DocumentTextRunPatch {
  if (!plainRecord(value)) throw new DocumentEditValidationError("Invalid text run");
  const fontSize = value.fontSize;
  if (fontSize !== null && (typeof fontSize !== "number" || !Number.isFinite(fontSize) || fontSize < 1 || fontSize > 512)) {
    throw new DocumentEditValidationError("Invalid font size");
  }
  const color = nullableString(value.color, "color", 7);
  if (color !== null && !/^#[0-9a-f]{6}$/iu.test(color)) throw new DocumentEditValidationError("Invalid color");
  const verticalAlign = enumValue(value.verticalAlign, ["baseline", "superscript", "subscript"], "vertical alignment");
  if (value.link !== null) throw new DocumentEditValidationError("Hyperlink editing is not supported");
  return {
    kind: "text",
    text: stringValue(value.text, "text", DOCUMENT_EDIT_LIMITS.maxTextPerBlock),
    bold: booleanValue(value.bold, "bold"),
    italic: booleanValue(value.italic, "italic"),
    underline: booleanValue(value.underline, "underline"),
    strike: booleanValue(value.strike, "strike"),
    fontSize,
    fontFamily: nullableString(value.fontFamily, "font family", DOCUMENT_EDIT_LIMITS.maxFontFamilyLength),
    color,
    verticalAlign,
    link: null,
  };
}

function block(value: unknown): DocumentBlockPatch {
  if (!plainRecord(value)) throw new DocumentEditValidationError("Invalid document block patch");
  if (typeof value.blockId !== "string" || !/^[a-z0-9-]{1,160}$/iu.test(value.blockId)) throw new DocumentEditValidationError("Invalid block ID");
  const type = enumValue(value.type, ["paragraph", "heading", "list-item"], "block type");
  const style = enumValue(value.style, ["preserve", "normal", "heading-1", "heading-2", "heading-3"], "paragraph style");
  const alignment = enumValue(value.alignment, ["left", "center", "right", "justified"], "alignment");
  if (!Array.isArray(value.content) || value.content.length > DOCUMENT_EDIT_LIMITS.maxRunsPerBlock) throw new DocumentEditValidationError("Invalid block content");
  const content = value.content.map(textRun);
  if (content.reduce((total, run) => total + run.text.length, 0) > DOCUMENT_EDIT_LIMITS.maxTextPerBlock) throw new DocumentEditValidationError("Block text is too long");
  return { blockId: value.blockId, type, style, alignment, content };
}

export function parseDocumentPatchRequest(value: unknown): DocumentPatchRequest {
  if (!plainRecord(value)) throw new DocumentEditValidationError("Invalid document save request");
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new DocumentEditValidationError("Document save request is invalid");
  }
  if (serialized.length > DOCUMENT_EDIT_LIMITS.maxPayloadBytes) throw new DocumentEditValidationError("Document save request is too large");
  const expectedRevision = stringValue(value.expectedRevision, "expected revision", 256);
  if (!expectedRevision) throw new DocumentEditValidationError("Expected revision is required");
  const operationId = value.operationId === undefined ? undefined : stringValue(value.operationId, "operation ID", 200);
  if (!Array.isArray(value.blocks) || value.blocks.length > DOCUMENT_EDIT_LIMITS.maxChangedBlocks) throw new DocumentEditValidationError("Invalid changed block count");
  const blocks = value.blocks.map(block);
  if (new Set(blocks.map((item) => item.blockId)).size !== blocks.length) throw new DocumentEditValidationError("Duplicate block ID");
  return { expectedRevision, blocks, ...(operationId ? { operationId } : {}) };
}
