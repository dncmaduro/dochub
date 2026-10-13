import type { SpreadsheetEditorState } from "./spreadsheet-editor/editor-state";
import type { WorkspaceMode } from "./workspace";

export function SpreadsheetToolbar({ state, mode, onUndo, onRedo }: { state: SpreadsheetEditorState; mode: WorkspaceMode; onUndo: () => void; onRedo: () => void }) {
  if (mode === "view") return null;
  const button = (label: string, action: () => void, disabled = false) => <button type="button" className="spreadsheet-tool-button" onMouseDown={(event) => event.preventDefault()} onClick={action} disabled={disabled}>{label}</button>;
  return <div className="spreadsheet-toolbar" role="toolbar" aria-label="Spreadsheet editing tools">
    {button("Undo", onUndo, !state.undoStack.length)}{button("Redo", onRedo, !state.redoStack.length)}
    <span className="spreadsheet-toolbar-divider" aria-hidden="true" />
    <span className="spreadsheet-toolbar-status" role="status">{state.saveStatus === "saving" ? "Saving…" : state.saveStatus === "unsaved" ? "Unsaved changes" : state.saveStatus === "conflict" ? "Conflict" : state.saveStatus === "failed" ? "Save failed" : "Saved"}</span>
  </div>;
}
