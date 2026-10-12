import type { PresentationElement, PresentationModel, PresentationParagraph, PresentationSlideModel, PresentationTextElement } from "../api";

export type PresentationMode = "view" | "edit";
export type PresentationSaveStatus = "saved" | "dirty" | "saving" | "error";

export interface PresentationEditorState {
  model: PresentationModel;
  slides: Record<string, PresentationSlideModel>;
  originalSlides: Record<string, PresentationSlideModel>;
  activeSlideId: string;
  selectedElementId: string | null;
  mode: PresentationMode;
  zoom: number;
  history: PresentationSnapshot[];
  future: PresentationSnapshot[];
  saveStatus: PresentationSaveStatus;
}

export interface PresentationSnapshot {
  slides: Record<string, PresentationSlideModel>;
  activeSlideId: string;
  selectedElementId: string | null;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createPresentationEditorState(model: PresentationModel, firstSlide: PresentationSlideModel): PresentationEditorState {
  return {
    model,
    slides: { [firstSlide.id]: firstSlide },
    originalSlides: { [firstSlide.id]: clone(firstSlide) },
    activeSlideId: firstSlide.id,
    selectedElementId: null,
    mode: "view",
    zoom: 1,
    history: [],
    future: [],
    saveStatus: "saved",
  };
}

export function snapshot(state: PresentationEditorState): PresentationSnapshot {
  return { slides: clone(state.slides), activeSlideId: state.activeSlideId, selectedElementId: state.selectedElementId };
}

function updateElements(elements: PresentationElement[], elementId: string, update: (element: PresentationElement) => PresentationElement): [PresentationElement[], boolean] {
  let changed = false;
  const next = elements.map((element) => {
    if (element.id === elementId) { changed = true; return update(element); }
    if (element.type === "group") {
      const [children, childChanged] = updateElements(element.children, elementId, update);
      if (childChanged) { changed = true; return { ...element, children }; }
    }
    return element;
  });
  return [next, changed];
}

function execute(state: PresentationEditorState, mutate: (slide: PresentationSlideModel) => PresentationSlideModel): PresentationEditorState {
  const current = state.slides[state.activeSlideId];
  if (!current) return state;
  const nextSlide = mutate(current);
  if (nextSlide === current) return state;
  return {
    ...state,
    slides: { ...state.slides, [state.activeSlideId]: nextSlide },
    history: [...state.history, snapshot(state)],
    future: [],
    saveStatus: "dirty",
  };
}

export function selectElement(state: PresentationEditorState, elementId: string | null): PresentationEditorState {
  return { ...state, selectedElementId: elementId };
}

export function selectSlide(state: PresentationEditorState, slideId: string): PresentationEditorState {
  if (!state.model.slides.some((slide) => slide.id === slideId)) return state;
  return { ...state, activeSlideId: slideId, selectedElementId: null };
}

export function loadSlide(state: PresentationEditorState, slide: PresentationSlideModel): PresentationEditorState {
  return state.slides[slide.id]
    ? { ...state, activeSlideId: slide.id, selectedElementId: null }
    : { ...state, slides: { ...state.slides, [slide.id]: slide }, originalSlides: { ...state.originalSlides, [slide.id]: clone(slide) }, activeSlideId: slide.id, selectedElementId: null };
}

export function moveElement(state: PresentationEditorState, elementId: string, x: number, y: number): PresentationEditorState {
  return execute(state, (slide) => {
    const [elements, changed] = updateElements(slide.elements, elementId, (element) => element.editable.move ? { ...element, x, y } : element);
    return changed ? { ...slide, elements } : slide;
  });
}

export function resizeElement(state: PresentationEditorState, elementId: string, width: number, height: number): PresentationEditorState {
  return execute(state, (slide) => {
    const [elements, changed] = updateElements(slide.elements, elementId, (element) => element.editable.resize ? { ...element, width: Math.max(1, width), height: Math.max(1, height) } : element);
    return changed ? { ...slide, elements } : slide;
  });
}

export function replaceText(state: PresentationEditorState, elementId: string, paragraphs: PresentationParagraph[]): PresentationEditorState {
  return execute(state, (slide) => {
    const [elements, changed] = updateElements(slide.elements, elementId, (element) => element.type === "text" && element.editable.text ? { ...element, paragraphs } : element);
    return changed ? { ...slide, elements } : slide;
  });
}

export function setFirstRunFormat(state: PresentationEditorState, elementId: string, format: Partial<Pick<PresentationTextElement["paragraphs"][number]["runs"][number], "bold" | "italic" | "underline" | "fontSize">>): PresentationEditorState {
  return execute(state, (slide) => {
    const [elements, changed] = updateElements(slide.elements, elementId, (element) => {
      if (element.type !== "text" || !element.editable.text) return element;
      const paragraphs = element.paragraphs.map((paragraph, paragraphIndex) => paragraphIndex !== 0 ? paragraph : { ...paragraph, runs: paragraph.runs.map((run, runIndex) => runIndex !== 0 ? run : { ...run, ...format }) });
      return { ...element, paragraphs };
    });
    return changed ? { ...slide, elements } : slide;
  });
}

export function undo(state: PresentationEditorState): PresentationEditorState {
  const previous = state.history.at(-1);
  if (!previous) return state;
  return { ...state, ...previous, history: state.history.slice(0, -1), future: [snapshot(state), ...state.future], saveStatus: "dirty" };
}

export function redo(state: PresentationEditorState): PresentationEditorState {
  const next = state.future[0];
  if (!next) return state;
  return { ...state, ...next, history: [...state.history, snapshot(state)], future: state.future.slice(1), saveStatus: "dirty" };
}

export function elementForId(slide: PresentationSlideModel | undefined, elementId: string | null): PresentationElement | null {
  if (!slide || !elementId) return null;
  const visit = (elements: PresentationElement[]): PresentationElement | null => {
    for (const element of elements) { if (element.id === elementId) return element; if (element.type === "group") { const nested = visit(element.children); if (nested) return nested; } }
    return null;
  };
  return visit(slide.elements);
}

export function textToString(element: PresentationTextElement): string {
  return element.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join("")).join("\n");
}

export function cloneParagraphs(element: PresentationTextElement): PresentationParagraph[] {
  return clone(element.paragraphs);
}
