import type { DocumentBlock, DocumentTextRun } from "../api";

export type EditableDocumentBlock = Extract<DocumentBlock, { type: "paragraph" | "heading" | "list-item" }>;
export type InlineFormat = "bold" | "italic" | "underline" | "strike";

export function blockText(block: EditableDocumentBlock): string {
  return block.content.filter((inline): inline is DocumentTextRun => inline.kind === "text").map((inline) => inline.text).join("");
}

export function normalizeRuns(runs: DocumentTextRun[]): DocumentTextRun[] {
  const result: DocumentTextRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const previous = result[result.length - 1];
    if (previous && sameFormatting(previous, run)) previous.text += run.text;
    else result.push({ ...run });
  }
  return result;
}

function sameFormatting(left: DocumentTextRun, right: DocumentTextRun): boolean {
  return left.bold === right.bold && left.italic === right.italic && left.underline === right.underline && left.strike === right.strike
    && left.fontSize === right.fontSize && left.fontFamily === right.fontFamily && left.color === right.color
    && left.verticalAlign === right.verticalAlign && JSON.stringify(left.link) === JSON.stringify(right.link);
}

function textRuns(block: EditableDocumentBlock): DocumentTextRun[] {
  return block.content.filter((inline): inline is DocumentTextRun => inline.kind === "text");
}

function splitRuns(runs: DocumentTextRun[], offset: number): [DocumentTextRun[], DocumentTextRun[]] {
  const left: DocumentTextRun[] = [];
  const right: DocumentTextRun[] = [];
  let remaining = offset;
  for (const run of runs) {
    if (remaining <= 0) {
      right.push({ ...run });
    } else if (remaining >= run.text.length) {
      left.push({ ...run });
      remaining -= run.text.length;
    } else {
      left.push({ ...run, text: run.text.slice(0, remaining) });
      right.push({ ...run, text: run.text.slice(remaining) });
      remaining = 0;
    }
  }
  return [left, right];
}

function runAtOffset(runs: DocumentTextRun[], offset: number): DocumentTextRun | null {
  let position = 0;
  for (const run of runs) {
    if (offset <= position + run.text.length) return run;
    position += run.text.length;
  }
  return runs[runs.length - 1] ?? null;
}

function withText(block: EditableDocumentBlock, content: DocumentTextRun[]): EditableDocumentBlock {
  return { ...block, content: normalizeRuns(content) };
}

export function replaceText(block: EditableDocumentBlock, start: number, end: number, replacement: string): EditableDocumentBlock {
  const runs = textRuns(block);
  const textLength = runs.reduce((total, run) => total + run.text.length, 0);
  const safeStart = Math.max(0, Math.min(start, textLength));
  const safeEnd = Math.max(safeStart, Math.min(end, textLength));
  const [before, afterStart] = splitRuns(runs, safeStart);
  const [, after] = splitRuns(afterStart, safeEnd - safeStart);
  const basis = runAtOffset(runs, safeStart) ?? runs[0] ?? {
    kind: "text" as const, id: `${block.id}-r1`, text: "", bold: false, italic: false, underline: false, strike: false,
    fontSize: null, fontFamily: null, color: null, verticalAlign: "baseline" as const, link: null,
  };
  const inserted = replacement ? [{ ...basis, id: `${block.id}-insert`, text: replacement }] : [];
  return withText(block, [...before, ...inserted, ...after]);
}

export function toggleFormatting(block: EditableDocumentBlock, start: number, end: number, format: InlineFormat): EditableDocumentBlock {
  const runs = textRuns(block);
  const textLength = runs.reduce((total, run) => total + run.text.length, 0);
  const safeStart = Math.max(0, Math.min(start, textLength));
  const safeEnd = Math.max(safeStart, Math.min(end, textLength));
  if (safeStart === safeEnd) return block;
  const [before, remainder] = splitRuns(runs, safeStart);
  const [selected, after] = splitRuns(remainder, safeEnd - safeStart);
  const shouldEnable = selected.some((run) => !run[format]);
  return withText(block, [...before, ...selected.map((run) => ({ ...run, [format]: shouldEnable })), ...after]);
}

export function setFontSize(block: EditableDocumentBlock, start: number, end: number, fontSize: number | null): EditableDocumentBlock {
  return setRunProperty(block, start, end, (run) => ({ ...run, fontSize }));
}

function setRunProperty(block: EditableDocumentBlock, start: number, end: number, update: (run: DocumentTextRun) => DocumentTextRun): EditableDocumentBlock {
  const runs = textRuns(block);
  const textLength = runs.reduce((total, run) => total + run.text.length, 0);
  const safeStart = Math.max(0, Math.min(start, textLength));
  const safeEnd = Math.max(safeStart, Math.min(end, textLength));
  if (safeStart === safeEnd) return block;
  const [before, remainder] = splitRuns(runs, safeStart);
  const [selected, after] = splitRuns(remainder, safeEnd - safeStart);
  return withText(block, [...before, ...selected.map(update), ...after]);
}

