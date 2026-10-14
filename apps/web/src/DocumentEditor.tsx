import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CompositionEvent, type CSSProperties, type ReactNode, type SyntheticEvent } from "react";
import { ApiClient, ApiError, type DocumentBlock, type DocumentModel, type DocumentTableCell, type DocumentTextRun } from "./api";
import { DocumentToolbar } from "./DocumentToolbar";
import { acceptSavedModel, createEditorState, executeEditorCommand, redo, replaceBaseline, restoreRecoveredModel, setSelection, undo, type BlockSelection, type DocumentEditorState } from "./document-editor/editor-state";
import type { DocumentCommand } from "./document-editor/commands";
import { blockText, type EditableDocumentBlock } from "./document-editor/run-utils";
import type { RegisterWorkspaceActions, WorkspaceMode } from "./workspace";
import { useRecoveryDraft } from "./useEditorPersistence";

const api = new ApiClient();

function paragraphStyle(block: { alignment: string; spacingBeforePt: number; spacingAfterPt: number; lineSpacing: number | null; indentLeftPt: number; indentRightPt: number; firstLineIndentPt: number }): CSSProperties {
  return {
    textAlign: block.alignment as CSSProperties["textAlign"], marginTop: `${block.spacingBeforePt}pt`, marginBottom: `${block.spacingAfterPt}pt`,
    lineHeight: block.lineSpacing ?? undefined, marginLeft: `${block.indentLeftPt}pt`, marginRight: `${block.indentRightPt}pt`, textIndent: `${block.firstLineIndentPt}pt`,
  };
}

function modelBlock(model: DocumentModel, id: string): EditableDocumentBlock | null {
  const visit = (blocks: DocumentBlock[]): EditableDocumentBlock | null => {
    for (const block of blocks) {
      if (block.id === id && (block.type === "paragraph" || block.type === "heading" || block.type === "list-item")) return block;
      if (block.type === "table") for (const row of block.rows) for (const cell of row.cells) {
        const found = visit(cell.blocks);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(model.blocks);
}

function editableBlock(block: DocumentBlock, onInput: (block: EditableDocumentBlock, value: string) => void, onSelect: (selection: BlockSelection) => void, onComposition: (blockId: string, composing: boolean, value?: string) => void, composingValue: string | undefined) {
  if (block.type !== "paragraph" && block.type !== "heading" && block.type !== "list-item") return null;
  if (block.editable === false) return <div key={block.id} className="document-editor-readonly" role="note">This block is read-only in the V1 editor.</div>;
  const value = composingValue ?? blockText(block);
  const style = paragraphStyle(block);
  const common = {
    key: block.id,
    className: "document-editable-block",
    "aria-label": block.type === "heading" ? `Heading ${block.level}` : block.type === "list-item" ? "List item" : "Paragraph",
    value,
    style,
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onInput(block, event.target.value),
    onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => onSelect({ blockId: block.id, anchorOffset: event.currentTarget.selectionStart, focusOffset: event.currentTarget.selectionEnd }),
    onCompositionStart: (event: CompositionEvent<HTMLTextAreaElement>) => onComposition(block.id, true, event.currentTarget.value),
    onCompositionUpdate: (event: CompositionEvent<HTMLTextAreaElement>) => onComposition(block.id, true, event.currentTarget.value),
    onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => onComposition(block.id, false, event.currentTarget.value),
  };
  return block.type === "heading" ? <textarea {...common} rows={1} /> : <textarea {...common} rows={Math.max(1, value.split("\n").length)} />;
}

function EditorBlocks({ blocks, state, onInput, onSelect, onComposition, composing }: { blocks: DocumentBlock[]; state: DocumentEditorState; onInput: (block: EditableDocumentBlock, value: string) => void; onSelect: (selection: BlockSelection) => void; onComposition: (blockId: string, composing: boolean, value?: string) => void; composing: Record<string, string | undefined> }) {
  const output: ReactNode[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === "list-item") {
      output.push(<div key={block.id} className="document-editor-list-item"><span className="document-list-marker" aria-hidden="true">{block.ordered ? "1." : "•"}</span>{editableBlock(block, onInput, onSelect, onComposition, composing[block.id])}</div>);
    } else if (block.type === "paragraph" || block.type === "heading") {
      const editor = editableBlock(block, onInput, onSelect, onComposition, composing[block.id]);
      output.push(block.type === "heading" ? <div key={block.id} className="document-editor-heading">{editor}</div> : editor);
    } else if (block.type === "unsupported") {
      output.push(<div key={block.id} className="document-editor-readonly" role="note">{block.label} (read-only)</div>);
    } else if (block.type === "table") {
      output.push(<table key={block.id} className="document-table"><tbody>{block.rows.map((row) => <tr key={row.id}>{row.cells.map((cell) => <EditorCell key={cell.id} cell={cell} state={state} onInput={onInput} onSelect={onSelect} onComposition={onComposition} composing={composing} />)}</tr>)}</tbody></table>);
    } else if (block.type === "image") {
      output.push(<figure key={block.id} className="document-image-block"><div className="document-editor-readonly">Images are read-only in V1.</div></figure>);
    }
  }
  return <>{output}</>;
}

function EditorCell({ cell, ...props }: { cell: DocumentTableCell; state: DocumentEditorState; onInput: (block: EditableDocumentBlock, value: string) => void; onSelect: (selection: BlockSelection) => void; onComposition: (blockId: string, composing: boolean, value?: string) => void; composing: Record<string, string | undefined> }) {
  return <td><EditorBlocks blocks={cell.blocks} {...props} /></td>;
}

function patchBlock(block: EditableDocumentBlock): Record<string, unknown> {
  return {
    blockId: block.id,
    type: block.type,
    style: block.type === "heading" && block.level >= 1 && block.level <= 3 ? `heading-${block.level}` : block.type === "paragraph" && block.styleId === null ? "normal" : "preserve",
    alignment: block.alignment,
    content: block.content.filter((inline): inline is DocumentTextRun => inline.kind === "text").map((run) => ({ ...run, link: null })),
  };
}

export function DocumentEditor({ nodeId, modelUrl, initialModel, mode, onModeChange, onRegisterActions, onDirtyChange, view }: { nodeId: string; modelUrl: string; initialModel: DocumentModel; mode: WorkspaceMode; onModeChange: (mode: WorkspaceMode) => void; onRegisterActions: RegisterWorkspaceActions; onDirtyChange: (dirty: boolean) => void; view: (model: DocumentModel) => ReactNode }) {
  const [state, setState] = useState<DocumentEditorState>(() => createEditorState(initialModel));
  const [composing, setComposing] = useState<Record<string, string | undefined>>({});
  const [saveError, setSaveError] = useState("");
  const composingIds = useRef(new Set<string>());
  const saveGeneration = useRef(0);
  const saveSnapshot = useRef<DocumentModel | null>(null);
  const postSaveCommands = useRef<DocumentCommand[] | null>(null);

  useEffect(() => onDirtyChange(state.dirtyBlockIds.size > 0), [onDirtyChange, state.dirtyBlockIds]);

  const command = useCallback((next: DocumentCommand) => {
    saveGeneration.current += 1;
    if (postSaveCommands.current) postSaveCommands.current.push(next);
    setState((current) => executeEditorCommand(current, next));
  }, []);
  const selected = useMemo(() => state.selection ? { start: Math.min(state.selection.anchorOffset, state.selection.focusOffset), end: Math.max(state.selection.anchorOffset, state.selection.focusOffset) } : null, [state.selection]);
  const selectedBlock = state.selection ? modelBlock(state.currentModel, state.selection.blockId) : null;

  const commitText = useCallback((block: EditableDocumentBlock, value: string) => {
    if (composingIds.current.has(block.id)) return;
    const oldText = blockText(block);
    const selection = state.selection?.blockId === block.id ? state.selection : { blockId: block.id, anchorOffset: oldText.length, focusOffset: oldText.length };
    const start = Math.min(selection.anchorOffset, selection.focusOffset);
    const end = Math.max(selection.anchorOffset, selection.focusOffset);
    const prefix = oldText.slice(0, start);
    const suffix = oldText.slice(end);
    const replacement = value.startsWith(prefix) && value.endsWith(suffix) ? value.slice(prefix.length, value.length - suffix.length || undefined) : value;
    command({ type: "replace-text", blockId: block.id, start, end, text: replacement });
  }, [command, state.selection]);

  const composition = useCallback((blockId: string, active: boolean, value?: string) => {
    if (active) {
      composingIds.current.add(blockId);
      setComposing((current) => ({ ...current, [blockId]: value }));
    } else {
      composingIds.current.delete(blockId);
      setComposing((current) => { const next = { ...current }; delete next[blockId]; return next; });
      const block = modelBlock(state.currentModel, blockId);
      if (block && value !== undefined) commitText(block, value);
    }
  }, [commitText, state.currentModel]);

  const recoveryDraft = useRecoveryDraft({
    fileId: nodeId,
    engine: "DOCUMENT",
    baseRevision: state.currentModel.storageRevision ?? "",
    isDirty: state.dirtyBlockIds.size > 0,
    buildDraftPayload: useCallback(() => ({ model: state.currentModel }), [state.currentModel]),
    applyRecoveredDraft: useCallback((payload: { model: DocumentModel }) => { setState((current) => restoreRecoveredModel(current, payload.model)); onModeChange("edit"); }, [onModeChange]),
  });
  const saveOperationId = useRef<string | null>(null);

  const save = useCallback(async () => {
    if (!state.currentModel.storageRevision || state.dirtyBlockIds.size === 0 || state.saveStatus === "saving" || state.saveStatus === "conflict") return;
    const expectedRevision = state.currentModel.storageRevision;
    const generation = saveGeneration.current;
    const snapshot = state.currentModel;
    saveSnapshot.current = snapshot;
    postSaveCommands.current = [];
    setSaveError("");
    setState((current) => ({ ...current, saveStatus: "saving" }));
    try {
      const changed = [...state.dirtyBlockIds].map((id) => modelBlock(snapshot, id)).filter((block): block is EditableDocumentBlock => Boolean(block)).map(patchBlock);
      const operationId = saveOperationId.current ?? crypto.randomUUID();
      saveOperationId.current = operationId;
      const saved = await api.saveDocument(nodeId, { expectedRevision, blocks: changed, operationId });
      const allLocalChangesSaved = saveGeneration.current === generation;
      const commands = postSaveCommands.current;
      setState((current) => acceptSavedModel(current, saved.model, snapshot, commands));
      if (allLocalChangesSaved) {
        recoveryDraft.clearCurrentDraft();
        composingIds.current.clear();
        setComposing({});
        onDirtyChange(false);
      }
      saveOperationId.current = null;
    } catch (error) {
      const conflict = error instanceof ApiError && (error.code === "FILE_REVISION_CONFLICT" || (error.status === 409 && !error.code));
      const message = conflict ? "This file changed after you opened it." : error instanceof Error ? error.message : "The document could not be saved.";
      setState((current) => ({ ...current, saveStatus: conflict ? "conflict" : "failed" }));
      setSaveError(message);
    } finally {
      if (saveSnapshot.current === snapshot) {
        saveSnapshot.current = null;
        postSaveCommands.current = null;
      }
    }
  }, [nodeId, onDirtyChange, recoveryDraft, state.currentModel, state.dirtyBlockIds, state.saveStatus]);

  const saveAsCopy = useCallback(async (name: string) => {
    if (!state.currentModel.storageRevision || state.dirtyBlockIds.size === 0) return;
    const blocks = [...state.dirtyBlockIds].map((id) => modelBlock(state.currentModel, id)).filter((block): block is EditableDocumentBlock => Boolean(block)).map(patchBlock);
    await api.saveAsCopy(nodeId, { name, expectedRevision: state.baselineModel.storageRevision ?? state.currentModel.storageRevision, blocks });
  }, [nodeId, state.baselineModel.storageRevision, state.currentModel, state.dirtyBlockIds]);

  const reload = useCallback(async () => {
    if (state.dirtyBlockIds.size && !window.confirm("Reload and discard unsaved changes?")) return;
    try {
      const fresh = await api.getDocumentModel(modelUrl);
      recoveryDraft.clearCurrentDraft();
      setState((current) => replaceBaseline(current, fresh));
      setSaveError("");
      onDirtyChange(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The document could not be reloaded.");
    }
  }, [modelUrl, onDirtyChange, recoveryDraft, state.dirtyBlockIds.size]);

  const discardAndView = useCallback(() => {
    if (state.dirtyBlockIds.size && !window.confirm("Discard unsaved changes?")) return;
    recoveryDraft.clearCurrentDraft();
    setState((current) => ({ ...replaceBaseline(current, current.baselineModel), mode: "view" }));
    onDirtyChange(false);
    onModeChange("view");
  }, [onDirtyChange, onModeChange, recoveryDraft, state.dirtyBlockIds.size]);

  useEffect(() => {
    onRegisterActions({
      save: () => { void save(); },
      saveAsCopy,
      view: discardAndView,
      canEdit: Boolean(initialModel.editable),
      canSave: state.dirtyBlockIds.size > 0 && state.saveStatus !== "saving" && state.saveStatus !== "conflict",
      saving: state.saveStatus === "saving",
    });
  }, [discardAndView, initialModel.editable, onRegisterActions, save, saveAsCopy, state.dirtyBlockIds.size, state.saveStatus]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (mode !== "edit") return;
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      if (event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      else if (event.key.toLowerCase() === "z") { event.preventDefault(); saveGeneration.current += 1; if (saveSnapshot.current) postSaveCommands.current = null; setState((current) => event.shiftKey ? redo(current) : undo(current)); }
      else if (event.key.toLowerCase() === "b" || event.key.toLowerCase() === "i" || event.key.toLowerCase() === "u") {
        event.preventDefault();
        if (!selected || !state.selection) return;
        command({ type: "toggle-format", blockId: state.selection.blockId, start: selected.start, end: selected.end, format: event.key.toLowerCase() === "b" ? "bold" : event.key.toLowerCase() === "i" ? "italic" : "underline" });
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [command, mode, save, selected, state.selection]);

  const toolbar = useMemo(() => <DocumentToolbar state={state} mode={mode} onUndo={() => { saveGeneration.current += 1; if (saveSnapshot.current) postSaveCommands.current = null; setState(undo); }} onRedo={() => { saveGeneration.current += 1; if (saveSnapshot.current) postSaveCommands.current = null; setState(redo); }} onFormat={(format) => { if (selected && state.selection) command({ type: "toggle-format", blockId: state.selection.blockId, start: selected.start, end: selected.end, format }); }} onAlignment={(alignment) => { if (state.selection) command({ type: "set-alignment", blockId: state.selection.blockId, alignment }); }} onStyle={(style) => { if (state.selection && selectedBlock?.type !== "list-item") command({ type: "set-style", blockId: state.selection.blockId, style }); }} onFontSize={(fontSize) => { if (selected && state.selection) command({ type: "set-font-size", blockId: state.selection.blockId, start: selected.start, end: selected.end, fontSize }); }} />, [command, mode, selected, selectedBlock, state]);

  return <div className="document-editor">{toolbar}{recoveryDraft.recovery && <div className="document-editor-error" role="alert"><span>{recoveryDraft.recoveryIsOutdated ? "An older recovery draft cannot be safely restored onto this file revision. Discard it or keep working on the current file." : "Unsaved changes from a previous session were found."}</span>{recoveryDraft.canRestoreRecovery && <button type="button" className="button" onClick={recoveryDraft.restore}>Restore</button>}<button type="button" className="button" onClick={recoveryDraft.discardRecovery}>Discard</button></div>}{saveError && <div className="document-editor-error" role="alert">{saveError}<button type="button" className="button" onClick={() => void reload()}>Reload</button></div>}{mode === "edit" ? <article className="document-surface document-edit-surface"><EditorBlocks blocks={state.currentModel.blocks} state={state} onInput={commitText} onSelect={(selection) => setState((current) => setSelection(current, selection))} onComposition={composition} composing={composing} /></article> : view(state.currentModel)}</div>;
}
