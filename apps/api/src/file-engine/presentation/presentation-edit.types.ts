import { PRESENTATION_LIMITS } from './presentation-limits.js';

export class PresentationEditValidationError extends Error {}

export interface PresentationTextRunPatch {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontFamily?: string | null;
  fontSize?: number | null;
  color?: string | null;
}

export interface PresentationParagraphPatch {
  alignment?: 'left' | 'center' | 'right' | 'justified';
  bullet?: { kind: 'bullet' | 'number'; value?: string | null; level?: number } | null;
  runs: PresentationTextRunPatch[];
}

export interface PresentationTextStatePatch {
  paragraphs: PresentationParagraphPatch[];
}

export interface PresentationGeometryPatch {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface PresentationElementPatch {
  elementId: string;
  textState?: PresentationTextStatePatch;
  geometry?: PresentationGeometryPatch;
}

export interface PresentationSlidePatch {
  slideId: string;
  elements: PresentationElementPatch[];
}

export interface PresentationPatchRequest {
  expectedRevision: string;
  slides: PresentationSlidePatch[];
  operationId?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PresentationEditValidationError('The presentation changes are invalid.');
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new PresentationEditValidationError(message);
  return value;
}

function finite(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new PresentationEditValidationError(message);
  return value;
}

export function parsePresentationPatchRequest(value: unknown): PresentationPatchRequest {
  const root = record(value);
  const expectedRevision = stringValue(root.expectedRevision, 'A presentation revision is required.');
  const operationId = root.operationId === undefined ? undefined : stringValue(root.operationId, 'A presentation operation ID is required.');
  if (operationId !== undefined && operationId.length > 200) throw new PresentationEditValidationError('The presentation operation ID is invalid.');
  if (!Array.isArray(root.slides) || root.slides.length > PRESENTATION_LIMITS.maxSlides) throw new PresentationEditValidationError('The presentation slide patch is invalid.');
  let patchCount = 0;
  const slides = root.slides.map((rawSlide) => {
    const slide = record(rawSlide);
    const slideId = stringValue(slide.slideId, 'A presentation slide identity is required.');
    if (!Array.isArray(slide.elements)) throw new PresentationEditValidationError('The presentation element patch is invalid.');
    const elements = slide.elements.map((rawElement) => {
      patchCount += 1;
      if (patchCount > PRESENTATION_LIMITS.maxPatchElements) throw new PresentationEditValidationError('Too many presentation edits.');
      const element = record(rawElement);
      const elementId = stringValue(element.elementId, 'A presentation element identity is required.');
      const result: PresentationElementPatch = { elementId };
      if (element.textState !== undefined) {
        const text = record(element.textState);
        if (!Array.isArray(text.paragraphs) || !text.paragraphs.length) throw new PresentationEditValidationError('A presentation text edit needs at least one paragraph.');
        const paragraphs = text.paragraphs.map((rawParagraph) => {
          const paragraph = record(rawParagraph);
          if (!Array.isArray(paragraph.runs)) throw new PresentationEditValidationError('A presentation paragraph must contain runs.');
          const alignment = (paragraph.alignment === undefined ? 'left' : paragraph.alignment) as 'left' | 'center' | 'right' | 'justified';
          if (!['left', 'center', 'right', 'justified'].includes(String(alignment))) throw new PresentationEditValidationError('The presentation paragraph alignment is invalid.');
          const bullet = paragraph.bullet === null || paragraph.bullet === undefined ? null : (() => {
            const rawBullet = record(paragraph.bullet);
            const kind = rawBullet.kind;
            if (kind !== 'bullet' && kind !== 'number') throw new PresentationEditValidationError('The presentation bullet is invalid.');
            const level = rawBullet.level === undefined ? 0 : finite(rawBullet.level, 'The presentation bullet level is invalid.');
            if (!Number.isInteger(level) || level < 0 || level > 8) throw new PresentationEditValidationError('The presentation bullet level is invalid.');
            return { kind, value: rawBullet.value === null || rawBullet.value === undefined ? null : stringValue(rawBullet.value, 'The presentation bullet is invalid.'), level } as const;
          })();
          const runs = paragraph.runs.map((rawRun) => {
            const run = record(rawRun);
            if (typeof run.text !== 'string') throw new PresentationEditValidationError('A presentation text run is invalid.');
            const textValue = run.text;
            if (textValue.length > PRESENTATION_LIMITS.maxTextLengthPerElement) throw new PresentationEditValidationError('A presentation text run is too long.');
            const parsed: PresentationTextRunPatch = { text: textValue };
            for (const key of ['bold', 'italic', 'underline'] as const) if (run[key] !== undefined) {
              if (typeof run[key] !== 'boolean') throw new PresentationEditValidationError('Presentation text formatting is invalid.');
              parsed[key] = run[key];
            }
            if (run.fontFamily !== undefined) parsed.fontFamily = run.fontFamily === null ? null : stringValue(run.fontFamily, 'The presentation font is invalid.');
            if (run.fontSize !== undefined) {
              const size = run.fontSize === null ? null : finite(run.fontSize, 'The presentation font size is invalid.');
              if (size !== null && (size <= 0 || size > 500)) throw new PresentationEditValidationError('The presentation font size is invalid.');
              parsed.fontSize = size;
            }
            if (run.color !== undefined) {
              if (run.color !== null && (typeof run.color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(run.color))) throw new PresentationEditValidationError('The presentation text color is invalid.');
              parsed.color = run.color as string | null;
            }
            return parsed;
          });
          return { runs, alignment, bullet };
        });
        const totalText = paragraphs.reduce((sum, paragraph) => sum + paragraph.runs.reduce((runs, run) => runs + run.text.length, 0), 0);
        if (totalText > PRESENTATION_LIMITS.maxTextLengthPerElement) throw new PresentationEditValidationError('The presentation text is too long.');
        result.textState = { paragraphs };
      }
      if (element.geometry !== undefined) {
        const geometry = record(element.geometry);
        const parsed: PresentationGeometryPatch = {};
        for (const key of ['x', 'y', 'width', 'height'] as const) if (geometry[key] !== undefined) parsed[key] = finite(geometry[key], 'The presentation geometry is invalid.');
        if (parsed.width !== undefined && (parsed.width <= 0 || parsed.width > 100_000_000)) throw new PresentationEditValidationError('The presentation width is invalid.');
        if (parsed.height !== undefined && (parsed.height <= 0 || parsed.height > 100_000_000)) throw new PresentationEditValidationError('The presentation height is invalid.');
        if (!Object.keys(parsed).length) throw new PresentationEditValidationError('The presentation geometry is invalid.');
        result.geometry = parsed;
      }
      if (!result.textState && !result.geometry) throw new PresentationEditValidationError('A presentation element patch is empty.');
      return result;
    });
    return { slideId, elements };
  });
  return { expectedRevision, slides, ...(operationId ? { operationId } : {}) };
}
