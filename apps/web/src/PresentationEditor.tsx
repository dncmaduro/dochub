import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiClient, ApiError, type PresentationParagraph, type PresentationSlideModel, type PresentationTextElement } from "./api";
import { PresentationToolbar } from "./PresentationToolbar";
import { SlideCanvas } from "./SlideCanvas";
import { SlideThumbnailRail } from "./SlideThumbnailRail";
import { createPresentationEditorState, elementForId, loadSlide, moveElement, redo, replaceText, resizeElement, selectElement, selectSlide, setFirstRunFormat, textToString, undo, type PresentationEditorState } from "./presentation-editor/editor-state";
import type { PresentationModel } from "./api";
import { fitSlideScale } from "./presentation-layout";
import type { RegisterWorkspaceActions, WorkspaceMode } from "./workspace";
import { useRecoveryDraft } from "./useEditorPersistence";

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

export function PresentationEditor({ modelUrl, nodeId, initialModel, mode, onModeChange, onRegisterActions, onReady, onError, onDirtyChange }: { modelUrl: string; nodeId: string; initialModel: PresentationModel; mode: WorkspaceMode; onModeChange: (mode: WorkspaceMode) => void; onRegisterActions: RegisterWorkspaceActions; onReady: () => void; onError: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [state, setState] = useState<PresentationEditorState | null>(null);
  const [loadingSlide, setLoadingSlide] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [draftElementId, setDraftElementId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [ready, setReady] = useState(false);
  const [thumbnailErrors, setThumbnailErrors] = useState<Record<string, string>>({});
  const pendingSlides = useRef(new Set<string>());
  const saveGeneration = useRef(0);
  const saveOperationId = useRef<string | null>(null);
  const stageScrollRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const activeSlide = state?.slides[state.activeSlideId];
  const selected = elementForId(activeSlide, state?.selectedElementId ?? null);

  const fetchSlide = useCallback(async (slideId: string, select: boolean) => {
    if (state?.slides[slideId]) {
      if (select) setState((value) => value ? selectSlide(value, slideId) : value);
      return;
    }
    if (pendingSlides.current.has(slideId)) return;
    pendingSlides.current.add(slideId);
    if (select) setLoadingSlide(true);
    try {
      const slide = await api.getPresentationSlide(modelUrl, slideId);
      setState((value) => value ? loadSlide(value, slide) : value);
      setThumbnailErrors((current) => { const next = { ...current }; delete next[slideId]; return next; });
      if (select) setState((value) => value ? selectSlide(value, slideId) : value);
    } catch {
      if (select) { setError("The slide could not be loaded."); onError(); }
      else setThumbnailErrors((current) => ({ ...current, [slideId]: "The thumbnail could not be loaded." }));
    } finally {
      pendingSlides.current.delete(slideId);
      if (select) setLoadingSlide(false);
    }
  }, [modelUrl, onError, state?.slides]);

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
  useEffect(() => { if (state?.saveStatus === "dirty") saveGeneration.current += 1; }, [state?.history.length, state?.saveStatus]);
  useLayoutEffect(() => {
    const node = stageScrollRef.current;
    if (!node) return undefined;
    const measure = () => setStageSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  const recoveryDraft = useRecoveryDraft({
    fileId: nodeId,
    engine: "PRESENTATION",
    baseRevision: state?.model.storageRevision ?? "",
    isDirty: state?.saveStatus === "dirty",
    buildDraftPayload: useCallback(() => ({ slides: state?.slides ?? {} }), [state?.slides]),
    applyRecoveredDraft: useCallback((payload: { slides: PresentationEditorState["slides"] }) => { setState((current) => current ? { ...current, slides: payload.slides, saveStatus: "dirty" } : current); onModeChange("edit"); }, [onModeChange]),
  });

  const save = useCallback(async () => {
    if (!state || state.saveStatus === "saving" || state.saveStatus === "conflict") return;
    const generation = saveGeneration.current;
    const slides = changedPatches(state.slides, state.originalSlides);
    if (!slides.length) { setState((current) => current ? { ...current, saveStatus: "saved" } : current); return; }
    const savedSlides = state.slides;
    setState((current) => current ? { ...current, saveStatus: "saving" } : current);
    try {
      const operationId = saveOperationId.current ?? crypto.randomUUID();
      saveOperationId.current = operationId;
      const result = await api.savePresentation(nodeId, { expectedRevision: state.model.storageRevision ?? "", slides, operationId });
      const allLocalChangesSaved = saveGeneration.current === generation;
      if (allLocalChangesSaved) recoveryDraft.clearCurrentDraft();
      setState((current) => current ? { ...current, model: result.model, originalSlides: allLocalChangesSaved ? current.slides : savedSlides, history: allLocalChangesSaved ? [] : current.history, future: allLocalChangesSaved ? [] : current.future, saveStatus: allLocalChangesSaved ? "saved" : "dirty" } : current);
      setError("");
      saveOperationId.current = null;
    } catch (caught) {
      const conflict = caught instanceof ApiError && (caught.code === "FILE_REVISION_CONFLICT" || (caught.status === 409 && !caught.code));
      setState((current) => current ? { ...current, saveStatus: conflict ? "conflict" : "error" } : current);
      setError(conflict ? "This file changed after you opened it." : caught instanceof Error ? caught.message : "The presentation could not be saved.");
    }
  }, [nodeId, recoveryDraft, state]);
  const saveAsCopy = useCallback(async (name: string) => {
    if (!state || !state.model.storageRevision) return;
    const slides = changedPatches(state.slides, state.originalSlides);
    if (!slides.length) return;
    await api.saveAsCopy(nodeId, { name, expectedRevision: state.model.storageRevision, slides });
  }, [nodeId, state]);
  const reload = useCallback(async () => {
    if (state && state.saveStatus !== "saved" && !window.confirm("Reload and discard unsaved changes?")) return;
    try {
      const model = await api.getPresentationModel(modelUrl);
      const slide = await api.getPresentationSlide(modelUrl, model.activeSlideId);
      recoveryDraft.clearCurrentDraft();
      setState(createPresentationEditorState(model, slide));
      setError("");
    } catch { setError("The presentation could not be reloaded."); }
  }, [modelUrl, recoveryDraft, state]);

  const commitDraft = useCallback(() => {
    if (!state || !selected || selected.type !== "text" || composing) return;
    const value = draftElementId === selected.id ? draft : textToString(selected);
    const nextParagraphs = paragraphsForDraft(selected, value);
    if (!same(selected.paragraphs, nextParagraphs)) setState((current) => current ? replaceText(current, selected.id, nextParagraphs) : current);
    setDraftElementId(null);
  }, [composing, draft, draftElementId, selected, state]);

  const chooseSlide = useCallback((slideId: string) => { void fetchSlide(slideId, true); }, [fetchSlide]);
  const loadThumbnail = useCallback((slideId: string) => { void fetchSlide(slideId, false); }, [fetchSlide]);
  const discardAndView = useCallback(() => {
    if (state?.saveStatus !== "saved" && !window.confirm("Discard unsaved changes?")) return;
    recoveryDraft.clearCurrentDraft();
    setState((current) => current ? { ...current, mode: "view", slides: current.originalSlides, history: [], future: [], selectedElementId: null, saveStatus: "saved" } : current);
    onDirtyChange(false);
    onModeChange("view");
  }, [onDirtyChange, onModeChange, recoveryDraft, state?.saveStatus]);
  useEffect(() => {
    onRegisterActions({ save: () => { void save(); }, saveAsCopy, view: discardAndView, canEdit: Boolean(state?.model.editable), canSave: state?.saveStatus === "dirty", saving: state?.saveStatus === "saving" });
  }, [discardAndView, onRegisterActions, save, saveAsCopy, state?.model.editable, state?.saveStatus]);
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
  const scale = current ? fitSlideScale({ width: stageSize.width, height: stageSize.height, slideWidth: current.width, slideHeight: current.height, zoom: state?.zoom ?? 1 }) : 1;
  const canvasStyle = useMemo(() => current ? ({ width: current.width * scale, height: current.height * scale }) : ({}), [current, scale]);
  if (!state || !current) return <div className="presentation-loading" role="status">{loadingSlide ? "Loading slide…" : "Loading presentation…"}</div>;
  return <div className="presentation-editor" onBlur={commitDraft}>
    <PresentationToolbar state={state} mode={mode} onUndo={() => setState((value) => value ? undo(value) : value)} onRedo={() => setState((value) => value ? redo(value) : value)} onBold={() => format("bold")} onItalic={() => format("italic")} onUnderline={() => format("underline")} onAlign={align} onFontSize={fontSize} onZoom={(delta) => setState((value) => value ? { ...value, zoom: Math.min(1.5, Math.max(0.5, value.zoom + delta)) } : value)} />
    {recoveryDraft.recovery && <div className="presentation-editor-error" role="alert"><span>{recoveryDraft.recoveryIsOutdated ? "An older recovery draft cannot be safely restored onto this file revision. Discard it or keep working on the current file." : "Unsaved changes from a previous session were found."}</span>{recoveryDraft.canRestoreRecovery && <button type="button" className="button" onClick={recoveryDraft.restore}>Restore</button>}<button type="button" className="button" onClick={recoveryDraft.discardRecovery}>Discard</button></div>}
    {error && <div className="presentation-editor-error" role="alert">{error}<button type="button" className="button" onClick={() => void reload()}>Reload</button></div>}
    <div className="presentation-workspace"><SlideThumbnailRail descriptors={state.model.slides} slides={state.slides} modelUrl={modelUrl} activeSlideId={state.activeSlideId} thumbnailErrors={thumbnailErrors} onLoad={loadThumbnail} onSelect={chooseSlide} /><main className="presentation-stage"><div ref={stageScrollRef} className="presentation-stage-scroll"><div className="presentation-canvas-scale" style={canvasStyle}><SlideCanvas modelUrl={modelUrl} slide={current} scale={scale} mode={mode} selectedElementId={state.selectedElementId} onSelect={(id) => { if (id && selectedText?.id !== id) setDraftElementId(null); setState((value) => value ? selectElement(value, id) : value); }} onMove={(id, x, y) => setState((value) => value ? moveElement(value, id, x, y) : value)} onResize={(id, width, height) => setState((value) => value ? resizeElement(value, id, width, height) : value)} /></div></div>{selectedText && mode === "edit" && <div className="presentation-text-editor"><label htmlFor="presentation-text-input">Text</label><textarea id="presentation-text-input" value={draftElementId === selectedText.id ? draft : textToString(selectedText)} onChange={(event) => { setDraftElementId(selectedText.id); setDraft(event.target.value); }} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); setDraftElementId(selectedText.id); setDraft(event.currentTarget.value); }} onBlur={commitDraft} rows={3} /></div>}</main></div>
  </div>;
}
