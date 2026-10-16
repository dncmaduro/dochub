import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CompositionEvent, type CSSProperties, type FocusEvent, type ReactNode, type SyntheticEvent } from "react";
import { ApiClient, ApiError, type DocumentBlock, type DocumentModel, type DocumentTableCell, type DocumentTextRun } from "./api";
import { DocumentToolbar } from "./DocumentToolbar";
import { acceptSavedModel, createEditorState, executeEditorCommand, redo, replaceBaseline, restoreRecoveredModel, setSelection, undo, type BlockSelection, type DocumentEditorState } from "./document-editor/editor-state";
import type { DocumentCommand } from "./document-editor/commands";
import { blockText, type EditableDocumentBlock } from "./document-editor/run-utils";
import type { RegisterWorkspaceActions, WorkspaceMode } from "./workspace";
import { useRecoveryDraft } from "./useEditorPersistence";

const api = new ApiClient();

interface TextInputSnapshot {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  isComposing: boolean;
}

type CompositionPhase = "start" | "update" | "end";

function inputSnapshot(event: ChangeEvent<HTMLTextAreaElement>): TextInputSnapshot {
  const nativeEvent = event.nativeEvent as InputEvent;
  return {
    value: event.currentTarget.value,
    selectionStart: event.currentTarget.selectionStart,
    selectionEnd: event.currentTarget.selectionEnd,
    isComposing: nativeEvent.isComposing === true,
  };
}

function compositionSnapshot(event: CompositionEvent<HTMLTextAreaElement>): TextInputSnapshot {
  return {
    value: event.currentTarget.value,
    selectionStart: event.currentTarget.selectionStart,
    selectionEnd: event.currentTarget.selectionEnd,
    isComposing: true,
  };
}

function blurSnapshot(event: FocusEvent<HTMLTextAreaElement>): TextInputSnapshot {
  return {
    value: event.currentTarget.value,
    selectionStart: event.currentTarget.selectionStart,
    selectionEnd: event.currentTarget.selectionEnd,
    isComposing: false,
  };
}

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

function editableBlock(
  block: DocumentBlock,
  onInput: (block: EditableDocumentBlock, snapshot: TextInputSnapshot) => void,
  onSelect: (selection: BlockSelection) => void,
  onComposition: (block: EditableDocumentBlock, phase: CompositionPhase, snapshot: TextInputSnapshot) => void,
  onBlur: (block: EditableDocumentBlock, snapshot: TextInputSnapshot) => void,
  composingValue: string | undefined,
) {
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
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onInput(block, inputSnapshot(event)),
    onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => onSelect({ blockId: block.id, anchorOffset: event.currentTarget.selectionStart, focusOffset: event.currentTarget.selectionEnd }),
    onCompositionStart: (event: CompositionEvent<HTMLTextAreaElement>) => onComposition(block, "start", compositionSnapshot(event)),
    onCompositionUpdate: (event: CompositionEvent<HTMLTextAreaElement>) => onComposition(block, "update", compositionSnapshot(event)),
    onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => onComposition(block, "end", compositionSnapshot(event)),
    onBlur: (event: FocusEvent<HTMLTextAreaElement>) => onBlur(block, blurSnapshot(event)),
  };
  return block.type === "heading" ? <textarea {...common} rows={1} /> : <textarea {...common} rows={Math.max(1, value.split("\n").length)} />;
}

function EditorBlocks({ blocks, state, onInput, onSelect, onComposition, onBlur, composing }: { blocks: DocumentBlock[]; state: DocumentEditorState; onInput: (block: EditableDocumentBlock, snapshot: TextInputSnapshot) => void; onSelect: (selection: BlockSelection) => void; onComposition: (block: EditableDocumentBlock, phase: CompositionPhase, snapshot: TextInputSnapshot) => void; onBlur: (block: EditableDocumentBlock, snapshot: TextInputSnapshot) => void; composing: Record<string, string | undefined> }) {
  const output: ReactNode[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === "list-item") {
      output.push(<div key={block.id} className="document-editor-list-item"><span className="document-list-marker" aria-hidden="true">{block.ordered ? "1." : "•"}</span>{editableBlock(block, onInput, onSelect, onComposition, onBlur, composing[block.id])}</div>);
    } else if (block.type === "paragraph" || block.type === "heading") {
      const editor = editableBlock(block, onInput, onSelect, onComposition, onBlur, composing[block.id]);
      output.push(block.type === "heading" ? <div key={block.id} className="document-editor-heading">{editor}</div> : editor);
    } else if (block.type === "unsupported") {
      output.push(<div key={block.id} className="document-editor-readonly" role="note">{block.label} (read-only)</div>);
    } else if (block.type === "table") {
      output.push(<table key={block.id} className="document-table"><tbody>{block.rows.map((row) => <tr key={row.id}>{row.cells.map((cell) => <EditorCell key={cell.id} cell={cell} state={state} onInput={onInput} onSelect={onSelect} onComposition={onComposition} onBlur={onBlur} composing={composing} />)}</tr>)}</tbody></table>);
    } else if (block.type === "image") {
      output.push(<figure key={block.id} className="document-image-block"><div className="document-editor-readonly">Images are read-only in V1.</div></figure>);
    }
  }
  return <>{output}</>;
}

function EditorCell({ cell, ...props }: { cell: DocumentTableCell; state: DocumentEditorState; onInput: (block: EditableDocumentBlock, snapshot: TextInputSnapshot) => void; onSelect: (selection: BlockSelection) => void; onComposition: (block: EditableDocumentBlock, phase: CompositionPhase, snapshot: TextInputSnapshot) => void; onBlur: (block: EditableDocumentBlock, snapshot: TextInputSnapshot) => void; composing: Record<string, string | undefined> }) {
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

function replaceTextCommand(block: EditableDocumentBlock, snapshot: TextInputSnapshot): DocumentCommand | null {
  const oldText = blockText(block);
  if (oldText === snapshot.value) return null;

  let start = 0;
  while (start < oldText.length && start < snapshot.value.length && oldText[start] === snapshot.value[start]) start += 1;
  let suffixLength = 0;
  while (
    suffixLength < oldText.length - start
    && suffixLength < snapshot.value.length - start
    && oldText[oldText.length - 1 - suffixLength] === snapshot.value[snapshot.value.length - 1 - suffixLength]
  ) suffixLength += 1;

  const text = snapshot.value.slice(start, snapshot.value.length - suffixLength);
  const end = oldText.length - suffixLength;
  // A textarea reports the caret after input. When that current DOM range agrees
  // with the diff, retain it as the command boundary instead of a semantic
  // selection saved before a rebase.
  const selectionStart = Math.max(0, Math.min(snapshot.selectionStart, snapshot.value.length));
  const selectionEnd = Math.max(selectionStart, Math.min(snapshot.selectionEnd, snapshot.value.length));
  const currentRangeStart = selectionStart === selectionEnd ? selectionStart - text.length : start;
  const commandStart = currentRangeStart === start ? currentRangeStart : start;

  return { type: "replace-text", blockId: block.id, start: commandStart, end, text };
}

function hasPendingCompositionText(model: DocumentModel, snapshots: Iterable<[string, TextInputSnapshot]>): boolean {
  return [...snapshots].some(([blockId, input]) => {
    const block = modelBlock(model, blockId);
    return block ? blockText(block) !== input.value : false;
  });
}

export function DocumentEditor({ nodeId, modelUrl, initialModel, mode, onModeChange, onRegisterActions, onDirtyChange, view }: { nodeId: string; modelUrl: string; initialModel: DocumentModel; mode: WorkspaceMode; onModeChange: (mode: WorkspaceMode) => void; onRegisterActions: RegisterWorkspaceActions; onDirtyChange: (dirty: boolean) => void; view: (model: DocumentModel) => ReactNode }) {
  const [state, setState] = useState<DocumentEditorState>(() => createEditorState(initialModel));
  const [composing, setComposing] = useState<Record<string, string | undefined>>({});
  const [saveError, setSaveError] = useState("");
  const composingIds = useRef(new Set<string>());
  const composingInputs = useRef(new Map<string, TextInputSnapshot>());
  const completedCompositionValues = useRef(new Map<string, string>());
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

  const clearActiveComposition = useCallback((blockId: string) => {
    composingIds.current.delete(blockId);
    composingInputs.current.delete(blockId);
    setComposing((current) => {
      if (!(blockId in current)) return current;
      const next = { ...current };
      delete next[blockId];
      return next;
    });
  }, []);

  const clearComposition = useCallback(() => {
    composingIds.current.clear();
    composingInputs.current.clear();
    completedCompositionValues.current.clear();
    setComposing((current) => Object.keys(current).length ? {} : current);
  }, []);

  const commitText = useCallback((block: EditableDocumentBlock, snapshot: TextInputSnapshot) => {
    if (snapshot.isComposing) return;
    const next = replaceTextCommand(block, snapshot);
    if (next) command(next);
  }, [command]);

  const composition = useCallback((block: EditableDocumentBlock, phase: CompositionPhase, snapshot: TextInputSnapshot) => {
    if (phase !== "end") {
      composingIds.current.add(block.id);
      composingInputs.current.set(block.id, snapshot);
      setComposing((current) => ({ ...current, [block.id]: snapshot.value }));
      return;
    }
    clearActiveComposition(block.id);
    // Some browsers fire a final non-composing input after compositionend. The
    // final value is committed here for browsers that do not, then deduplicated
    // by onInput if that trailing event arrives.
    completedCompositionValues.current.set(block.id, snapshot.value);
    commitText(block, { ...snapshot, isComposing: false });
  }, [clearActiveComposition, commitText]);

  const input = useCallback((block: EditableDocumentBlock, snapshot: TextInputSnapshot) => {
    if (snapshot.isComposing) {
      composition(block, "update", snapshot);
      return;
    }
    // A normal input is authoritative evidence that composition has ended. This
    // recovers when compositionend was missed by an IME, focus change, or DOM
    // interference instead of leaving the block permanently input-dead.
    clearActiveComposition(block.id);
    if (completedCompositionValues.current.get(block.id) === snapshot.value) {
      completedCompositionValues.current.delete(block.id);
      return;
    }
    completedCompositionValues.current.delete(block.id);
    commitText(block, snapshot);
  }, [clearActiveComposition, commitText, composition]);

  const blur = useCallback((block: EditableDocumentBlock, snapshot: TextInputSnapshot) => {
    if (!composingIds.current.has(block.id)) return;
    clearActiveComposition(block.id);
    completedCompositionValues.current.set(block.id, snapshot.value);
    // Synchronize the DOM value before clearing a potentially interrupted
    // composition so text typed immediately before blur is retained.
    commitText(block, snapshot);
  }, [clearActiveComposition, commitText]);

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
      const commands = postSaveCommands.current;
      const pendingCompositionSnapshots = [...composingInputs.current.entries()];
      const hasPendingComposition = hasPendingCompositionText(snapshot, pendingCompositionSnapshots);
      const allLocalChangesSaved = saveGeneration.current === generation && !hasPendingComposition;
      setState((current) => {
        const pendingCompositionCommands = pendingCompositionSnapshots.flatMap(([blockId, input]) => {
          const block = modelBlock(current.currentModel, blockId);
          const next = block ? replaceTextCommand(block, input) : null;
          return next ? [next] : [];
        });
        const currentWithComposition = pendingCompositionCommands.reduce(executeEditorCommand, current);
        const commandsForRebase = commands === null ? null : [...commands, ...pendingCompositionCommands];
        return acceptSavedModel(currentWithComposition, saved.model, snapshot, commandsForRebase);
      });
      if (allLocalChangesSaved) {
        recoveryDraft.clearCurrentDraft();
        clearComposition();
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
  }, [clearComposition, nodeId, onDirtyChange, recoveryDraft, state.currentModel, state.dirtyBlockIds, state.saveStatus]);

  const saveAsCopy = useCallback(async (name: string) => {
    if (!state.currentModel.storageRevision || state.dirtyBlockIds.size === 0) return;
    const blocks = [...state.dirtyBlockIds].map((id) => modelBlock(state.currentModel, id)).filter((block): block is EditableDocumentBlock => Boolean(block)).map(patchBlock);
    await api.saveAsCopy(nodeId, { name, expectedRevision: state.baselineModel.storageRevision ?? state.currentModel.storageRevision, blocks });
  }, [nodeId, state.baselineModel.storageRevision, state.currentModel, state.dirtyBlockIds]);

  const reload = useCallback(async () => {
    if ((state.dirtyBlockIds.size || hasPendingCompositionText(state.currentModel, composingInputs.current)) && !window.confirm("Reload and discard unsaved changes?")) return;
    try {
      const fresh = await api.getDocumentModel(modelUrl);
      recoveryDraft.clearCurrentDraft();
      clearComposition();
      setState((current) => replaceBaseline(current, fresh));
      setSaveError("");
      onDirtyChange(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The document could not be reloaded.");
    }
  }, [clearComposition, modelUrl, onDirtyChange, recoveryDraft, state.currentModel, state.dirtyBlockIds.size]);

  const discardAndView = useCallback(() => {
    if ((state.dirtyBlockIds.size || hasPendingCompositionText(state.currentModel, composingInputs.current)) && !window.confirm("Discard unsaved changes?")) return;
    recoveryDraft.clearCurrentDraft();
    clearComposition();
    setState((current) => ({ ...replaceBaseline(current, current.baselineModel), mode: "view" }));
    onDirtyChange(false);
    onModeChange("view");
  }, [clearComposition, onDirtyChange, onModeChange, recoveryDraft, state.currentModel, state.dirtyBlockIds.size]);

  useEffect(() => {
    if (mode === "edit") return;
    composingIds.current.clear();
    composingInputs.current.clear();
    completedCompositionValues.current.clear();
    queueMicrotask(() => setComposing((current) => Object.keys(current).length ? {} : current));
  }, [mode]);

  useEffect(() => () => {
    composingIds.current.clear();
    composingInputs.current.clear();
    completedCompositionValues.current.clear();
  }, []);

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

  return <div className="document-editor">{toolbar}{recoveryDraft.recovery && <div className="document-editor-error" role="alert"><span>{recoveryDraft.recoveryIsOutdated ? "An older recovery draft cannot be safely restored onto this file revision. Discard it or keep working on the current file." : "Unsaved changes from a previous session were found."}</span>{recoveryDraft.canRestoreRecovery && <button type="button" className="button" onClick={recoveryDraft.restore}>Restore</button>}<button type="button" className="button" onClick={recoveryDraft.discardRecovery}>Discard</button></div>}{saveError && <div className="document-editor-error" role="alert">{saveError}<button type="button" className="button" onClick={() => void reload()}>Reload</button></div>}{mode === "edit" ? <article className="document-surface document-edit-surface"><EditorBlocks blocks={state.currentModel.blocks} state={state} onInput={input} onSelect={(selection) => setState((current) => setSelection(current, selection))} onComposition={composition} onBlur={blur} composing={composing} /></article> : view(state.currentModel)}</div>;
}
