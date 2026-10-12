import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CompositionEvent, type CSSProperties, type ReactNode, type SyntheticEvent } from "react";
import { ApiClient, ApiError, type DocumentBlock, type DocumentModel, type DocumentTableCell, type DocumentTextRun } from "./api";
import { DocumentToolbar } from "./DocumentToolbar";
import { createEditorState, executeEditorCommand, redo, replaceBaseline, setSelection, undo, type BlockSelection, type DocumentEditorState } from "./document-editor/editor-state";
import type { DocumentCommand } from "./document-editor/commands";
import { blockText, type EditableDocumentBlock } from "./document-editor/run-utils";

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

export function DocumentEditor({ nodeId, modelUrl, initialModel, canEdit, onDirtyChange, view }: { nodeId: string; modelUrl: string; initialModel: DocumentModel; canEdit: boolean; onDirtyChange: (dirty: boolean) => void; view: (model: DocumentModel) => ReactNode }) {
  const [state, setState] = useState<DocumentEditorState>(() => createEditorState(initialModel));
  const [composing, setComposing] = useState<Record<string, string | undefined>>({});
  const [saveError, setSaveError] = useState("");
  const composingIds = useRef(new Set<string>());

  useEffect(() => onDirtyChange(state.dirtyBlockIds.size > 0), [onDirtyChange, state.dirtyBlockIds]);

  const command = useCallback((next: DocumentCommand) => setState((current) => executeEditorCommand(current, next)), []);
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

  const save = useCallback(async () => {
    if (!state.currentModel.storageRevision || state.dirtyBlockIds.size === 0) return;
    setSaveError("");
    setState((current) => ({ ...current, saveStatus: "saving" }));
    try {
      const changed = [...state.dirtyBlockIds].map((id) => modelBlock(state.currentModel, id)).filter((block): block is EditableDocumentBlock => Boolean(block)).map(patchBlock);
      await api.saveDocument(nodeId, { expectedRevision: state.currentModel.storageRevision, blocks: changed });
      const fresh = await api.getDocumentModel(modelUrl);
      setState((current) => replaceBaseline({ ...current, saveStatus: "saved" }, fresh));
      onDirtyChange(false);
    } catch (error) {
      const message = error instanceof ApiError && error.status === 409 ? "This file changed after you opened it." : error instanceof Error ? error.message : "The document could not be saved.";
      setState((current) => ({ ...current, saveStatus: "failed" }));
      setSaveError(message);
    }
  }, [modelUrl, nodeId, onDirtyChange, state.currentModel, state.dirtyBlockIds]);

  const reload = useCallback(async () => {
    if (state.dirtyBlockIds.size && !window.confirm("Reload and discard unsaved changes?")) return;
    try {
      const fresh = await api.getDocumentModel(modelUrl);
      setState((current) => replaceBaseline(current, fresh));
      setSaveError("");
      onDirtyChange(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The document could not be reloaded.");
    }
  }, [modelUrl, onDirtyChange, state.dirtyBlockIds.size]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (state.mode !== "edit") return;
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      if (event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      else if (event.key.toLowerCase() === "z") { event.preventDefault(); setState((current) => event.shiftKey ? redo(current) : undo(current)); }
      else if (event.key.toLowerCase() === "b" || event.key.toLowerCase() === "i" || event.key.toLowerCase() === "u") {
        event.preventDefault();
        if (!selected || !state.selection) return;
        command({ type: "toggle-format", blockId: state.selection.blockId, start: selected.start, end: selected.end, format: event.key.toLowerCase() === "b" ? "bold" : event.key.toLowerCase() === "i" ? "italic" : "underline" });
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [command, save, selected, state.mode, state.selection]);

  const toolbar = useMemo(() => <DocumentToolbar state={state} canEdit={canEdit} onEdit={() => setState((current) => ({ ...current, mode: "edit" }))} onUndo={() => setState(undo)} onRedo={() => setState(redo)} onFormat={(format) => { if (selected && state.selection) command({ type: "toggle-format", blockId: state.selection.blockId, start: selected.start, end: selected.end, format }); }} onAlignment={(alignment) => { if (state.selection) command({ type: "set-alignment", blockId: state.selection.blockId, alignment }); }} onStyle={(style) => { if (state.selection && selectedBlock?.type !== "list-item") command({ type: "set-style", blockId: state.selection.blockId, style }); }} onFontSize={(fontSize) => { if (selected && state.selection) command({ type: "set-font-size", blockId: state.selection.blockId, start: selected.start, end: selected.end, fontSize }); }} onSave={() => void save()} onView={() => {
    if (state.dirtyBlockIds.size && !window.confirm("Discard unsaved changes?")) return;
    setState((current) => ({ ...replaceBaseline(current, current.baselineModel), mode: "view" }));
  }} />, [canEdit, command, save, selected, selectedBlock, state]);

  return <div className="document-editor">{toolbar}{saveError && <div className="document-editor-error" role="alert">{saveError}<button type="button" className="button" onClick={() => void reload()}>Reload</button></div>}{state.mode === "edit" ? <article className="document-surface document-edit-surface"><EditorBlocks blocks={state.currentModel.blocks} state={state} onInput={commitText} onSelect={(selection) => setState((current) => setSelection(current, selection))} onComposition={composition} composing={composing} /></article> : view(state.currentModel)}</div>;
}
