import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClient, type PresentationParagraph, type PresentationSlideModel, type PresentationTextElement } from "./api";
import { PresentationToolbar } from "./PresentationToolbar";
import { SlideCanvas } from "./SlideCanvas";
import { SlideThumbnailRail } from "./SlideThumbnailRail";
import { createPresentationEditorState, elementForId, loadSlide, moveElement, redo, replaceText, resizeElement, selectElement, selectSlide, setFirstRunFormat, textToString, undo, type PresentationEditorState } from "./presentation-editor/editor-state";
import type { PresentationModel } from "./api";

const api = new ApiClient();

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function textState(element: PresentationTextElement) {
  return { paragraphs: element.paragraphs.map((paragraph) => ({ alignment: paragraph.alignment, bullet: paragraph.bullet ? { kind: paragraph.bullet.kind, value: paragraph.bullet.value, level: paragraph.bullet.level } : null, runs: paragraph.runs.map((run) => ({ text: run.text, bold: run.bold, italic: run.italic, underline: run.underline, fontFamily: run.fontFamily, fontSize: run.fontSize, color: run.color })) })) };
}

function allElements(slide: PresentationSlideModel) {
  const result = [] as Array<PresentationSlideModel["elements"][number]>;
  const visit = (elements: PresentationSlideModel["elements"]) => { for (const element of elements) { result.push(element); if (element.type === "group") visit(element.children); } };
  visit(slide.elements);
  return result;
}

function changedPatches(current: Record<string, PresentationSlideModel>, original: Record<string, PresentationSlideModel>) {
  return Object.entries(current).map(([slideId, slide]) => {
    const before = original[slideId];
    if (!before) return null;
    const previous = new Map(allElements(before).map((element) => [element.id, element]));
    const elements = allElements(slide).flatMap((element) => {
      const old = previous.get(element.id);
      if (!old) return [];
      const patch: { elementId: string; textState?: ReturnType<typeof textState>; geometry?: { x?: number; y?: number; width?: number; height?: number } } = { elementId: element.id };
      if (element.type === "text" && old.type === "text" && !same(element.paragraphs, old.paragraphs)) patch.textState = textState(element);
      const geometry: { x?: number; y?: number; width?: number; height?: number } = {};
      for (const key of ["x", "y", "width", "height"] as const) if (element[key] !== old[key]) geometry[key] = element[key];
      if (Object.keys(geometry).length) patch.geometry = geometry;
      return patch.textState || patch.geometry ? [patch] : [];
    });
    return elements.length ? { slideId, elements } : null;
  }).filter((slide): slide is { slideId: string; elements: Array<{ elementId: string; textState?: ReturnType<typeof textState>; geometry?: { x?: number; y?: number; width?: number; height?: number } }> } => Boolean(slide));
}

function paragraphsForDraft(element: PresentationTextElement, draft: string): PresentationParagraph[] {
  const lines = draft.split("\n");
  return lines.map((line, index) => {
    const source = element.paragraphs[index] ?? element.paragraphs[0];
    const run = source?.runs[0];
    return { id: source?.id ?? `p-${index}`, alignment: source?.alignment ?? "left", bullet: source?.bullet ?? null, runs: [{ id: run?.id ?? `r-${index}`, text: line, bold: run?.bold ?? false, italic: run?.italic ?? false, underline: run?.underline ?? false, fontFamily: run?.fontFamily ?? null, fontSize: run?.fontSize ?? null, color: run?.color ?? null, link: null }] };
  });
}

export function PresentationEditor({ modelUrl, nodeId, initialModel, canEdit, onReady, onError, onDirtyChange }: { modelUrl: string; nodeId: string; initialModel: PresentationModel; canEdit: boolean; onReady: () => void; onError: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [state, setState] = useState<PresentationEditorState | null>(null);
  const [loadingSlide, setLoadingSlide] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [draftElementId, setDraftElementId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [ready, setReady] = useState(false);
  const activeSlide = state?.slides[state.activeSlideId];
  const selected = elementForId(activeSlide, state?.selectedElementId ?? null);

  const fetchSlide = useCallback(async (current: PresentationEditorState, slideId: string) => {
    if (current.slides[slideId]) { setState((value) => value ? selectSlide(value, slideId) : value); return; }
    setLoadingSlide(true);
    try {
      const slide = await api.getPresentationSlide(modelUrl, slideId);
      setState((value) => value ? loadSlide(value, slide) : value);
    } catch { setError("The slide could not be loaded."); onError(); }
    finally { setLoadingSlide(false); }
  }, [modelUrl, onError]);

  useEffect(() => {
    let active = true;
    void api.getPresentationSlide(modelUrl, initialModel.activeSlideId).then((slide) => {
      if (!active) return;
      setState(createPresentationEditorState(initialModel, slide));
      setReady(true);
      onReady();
    }).catch(() => { if (active) { setError("The presentation slide could not be loaded."); onError(); } });
    return () => { active = false; };
  }, [initialModel, modelUrl, onError, onReady]);

  useEffect(() => { onDirtyChange(Boolean(state && state.saveStatus !== "saved")); }, [onDirtyChange, state]);

  const save = useCallback(async () => {
    if (!state || state.saveStatus === "saving") return;
    const slides = changedPatches(state.slides, state.originalSlides);
    if (!slides.length) { setState((current) => current ? { ...current, saveStatus: "saved" } : current); return; }
    setState((current) => current ? { ...current, saveStatus: "saving" } : current);
    try {
      const result = await api.savePresentation(nodeId, { expectedRevision: state.model.storageRevision ?? "", slides });
      setState((current) => current ? { ...current, model: result.model, originalSlides: current.slides, history: [], future: [], saveStatus: "saved" } : current);
      setError("");
    } catch (caught) {
      setState((current) => current ? { ...current, saveStatus: "error" } : current);
      setError(caught instanceof Error && "status" in caught && (caught as { status?: number }).status === 409 ? "This file changed after you opened it." : caught instanceof Error ? caught.message : "The presentation could not be saved.");
    }
  }, [nodeId, state]);

  const reload = useCallback(async () => {
    if (state && state.saveStatus !== "saved" && !window.confirm("Reload and discard unsaved changes?")) return;
    try {
      const model = await api.getPresentationModel(modelUrl);
      const slide = await api.getPresentationSlide(modelUrl, model.activeSlideId);
      setState(createPresentationEditorState(model, slide));
      setError("");
    } catch { setError("The presentation could not be reloaded."); }
  }, [modelUrl, state]);

  const commitDraft = useCallback(() => {
    if (!state || !selected || selected.type !== "text" || composing) return;
    const value = draftElementId === selected.id ? draft : textToString(selected);
    const nextParagraphs = paragraphsForDraft(selected, value);
    if (!same(selected.paragraphs, nextParagraphs)) setState((current) => current ? replaceText(current, selected.id, nextParagraphs) : current);
    setDraftElementId(null);
  }, [composing, draft, draftElementId, selected, state]);

  const chooseSlide = useCallback((slideId: string) => { if (state) void fetchSlide(state, slideId); }, [fetchSlide, state]);
  const edit = useCallback(() => setState((current) => current ? { ...current, mode: "edit" } : current), []);
  const view = useCallback(() => {
    if (state?.saveStatus !== "saved" && !window.confirm("Discard unsaved changes?")) return;
    setState((current) => current ? { ...current, mode: "view", slides: current.originalSlides, history: [], future: [], selectedElementId: null, saveStatus: "saved" } : current);
  }, [state?.saveStatus]);
  const format = useCallback((key: "bold" | "italic" | "underline") => setState((current) => current && selected?.type === "text" ? setFirstRunFormat(current, selected.id, { [key]: !(selected.paragraphs[0]?.runs[0]?.[key] ?? false) }) : current), [selected]);
  const align = useCallback((alignment: "left" | "center" | "right" | "justified") => setState((current) => current && selected?.type === "text" ? replaceText(current, selected.id, selected.paragraphs.map((paragraph) => ({ ...paragraph, alignment }))) : current), [selected]);
  const fontSize = useCallback((size: number) => setState((current) => current && selected?.type === "text" ? setFirstRunFormat(current, selected.id, { fontSize: size }) : current), [selected]);

  useEffect(() => {
    if (!ready) return;
    const keyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      else if (modifier && event.key.toLowerCase() === "z") { event.preventDefault(); setState((current) => current ? (event.shiftKey ? redo(current) : undo(current)) : current); }
    };
    document.addEventListener("keydown", keyDown);
    return () => document.removeEventListener("keydown", keyDown);
  }, [ready, save]);

  const current = state && activeSlide ? activeSlide : null;
  const selectedText = selected?.type === "text" ? selected : null;
  const scale = state?.zoom ?? 1;
  const canvasStyle = useMemo(() => ({ transform: `scale(${scale})`, transformOrigin: "top center" }), [scale]);
  if (!state || !current) return <div className="presentation-loading" role="status">{loadingSlide ? "Loading slide…" : "Loading presentation…"}</div>;
  return <div className="presentation-editor" onBlur={commitDraft}>
    <PresentationToolbar state={state} canEdit={canEdit && state.model.editable} onEdit={edit} onView={view} onUndo={() => setState((value) => value ? undo(value) : value)} onRedo={() => setState((value) => value ? redo(value) : value)} onSave={() => void save()} onBold={() => format("bold")} onItalic={() => format("italic")} onUnderline={() => format("underline")} onAlign={align} onFontSize={fontSize} onZoom={(delta) => setState((value) => value ? { ...value, zoom: Math.min(1.5, Math.max(0.5, value.zoom + delta)) } : value)} />
    {error && <div className="presentation-editor-error" role="alert">{error}<button type="button" className="button" onClick={() => void reload()}>Reload</button></div>}
    <div className="presentation-workspace"><SlideThumbnailRail descriptors={state.model.slides} slides={state.slides} modelUrl={modelUrl} activeSlideId={state.activeSlideId} onSelect={chooseSlide} /><main className="presentation-stage"><div className="presentation-stage-scroll"><div className="presentation-canvas-scale" style={canvasStyle}><SlideCanvas modelUrl={modelUrl} slide={current} mode={state.mode} selectedElementId={state.selectedElementId} onSelect={(id) => { if (id && selectedText?.id !== id) setDraftElementId(null); setState((value) => value ? selectElement(value, id) : value); }} onMove={(id, x, y) => setState((value) => value ? moveElement(value, id, x, y) : value)} onResize={(id, width, height) => setState((value) => value ? resizeElement(value, id, width, height) : value)} /></div></div>{selectedText && state.mode === "edit" && <div className="presentation-text-editor"><label htmlFor="presentation-text-input">Text</label><textarea id="presentation-text-input" value={draftElementId === selectedText.id ? draft : textToString(selectedText)} onChange={(event) => { setDraftElementId(selectedText.id); setDraft(event.target.value); }} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); setDraftElementId(selectedText.id); setDraft(event.currentTarget.value); }} onBlur={commitDraft} rows={3} /></div>}</main></div>
  </div>;
}
