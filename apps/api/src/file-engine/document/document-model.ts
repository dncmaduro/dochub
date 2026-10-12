export type DocumentAlignment = "left" | "center" | "right" | "justified";
export type DocumentVerticalAlign = "baseline" | "superscript" | "subscript";

export interface TextRun {
  kind: "text";
  id: string;
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fontSize: number | null;
  fontFamily: string | null;
  color: string | null;
  verticalAlign: DocumentVerticalAlign;
  link: { href: string } | null;
}

export interface InlineImage {
  kind: "image";
  id: string;
  assetId: string;
  src?: string;
  altText: string | null;
  widthPx: number | null;
  heightPx: number | null;
}

export type DocumentInline = TextRun | InlineImage;

export interface ParagraphLayout {
  alignment: DocumentAlignment;
  spacingBeforePt: number;
  spacingAfterPt: number;
  lineSpacing: number | null;
  indentLeftPt: number;
  indentRightPt: number;
  firstLineIndentPt: number;
}

export interface ParagraphBlock extends ParagraphLayout {
  type: "paragraph";
  id: string;
  styleId: string | null;
  content: DocumentInline[];
  /** False when the original paragraph contains OOXML outside the V1 safe subset. */
  editable?: boolean;
  readonlyReason?: string;
}

export interface HeadingBlock extends Omit<ParagraphBlock, "type"> {
  type: "heading";
  level: number;
}

export interface ListItemBlock extends ParagraphLayout {
  type: "list-item";
  id: string;
  styleId: string | null;
  content: DocumentInline[];
  level: number;
  ordered: boolean;
  marker: string | null;
  editable?: boolean;
  readonlyReason?: string;
}

export interface TableBorder {
  style: string | null;
  color: string | null;
  widthPt: number | null;
}

export interface TableCell {
  id: string;
  blocks: DocumentBlock[];
  widthPx: number | null;
  backgroundColor: string | null;
  borders: Partial<Record<"top" | "right" | "bottom" | "left", TableBorder>>;
}

export interface TableRow {
  id: string;
  cells: TableCell[];
}

export interface TableBlock {
  type: "table";
  id: string;
  rows: TableRow[];
  columnWidthsPx: Array<number | null>;
}

export interface ImageBlock {
  type: "image";
  id: string;
  assetId: string;
  src?: string;
  altText: string | null;
  widthPx: number | null;
  heightPx: number | null;
  editable?: boolean;
}

export interface UnsupportedBlock {
  type: "unsupported";
  id: string;
  label: string;
  editable?: boolean;
}

export type DocumentBlock =
  | ParagraphBlock
  | HeadingBlock
  | ListItemBlock
  | TableBlock
  | ImageBlock
  | UnsupportedBlock;

export interface DocumentModel {
  version: 1;
  blocks: DocumentBlock[];
  /** True when at least one safe paragraph can be edited in V1. */
  editable?: boolean;
  /** Opaque provider revision attached by the preview/session layer. */
  storageRevision?: string;
}
