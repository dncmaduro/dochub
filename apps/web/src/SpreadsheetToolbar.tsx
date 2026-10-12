import type { SpreadsheetEditorState } from "./spreadsheet-editor/editor-state";

export function SpreadsheetToolbar({ state, canEdit, onEdit, onUndo, onRedo, onSave, onView }: { state: SpreadsheetEditorState; canEdit: boolean; onEdit: () => void; onUndo: () => void; onRedo: () => void; onSave: () => void; onView: () => void }) {
  if (state.mode === "view") return canEdit ? <div className="spreadsheet-toolbar spreadsheet-toolbar-view"><button type="button" className="button" onClick={onEdit}>Edit</button></div> : null;
  const button = (label: string, action: () => void, disabled = false) => <button type="button" className="spreadsheet-tool-button" onMouseDown={(event) => event.preventDefault()} onClick={action} disabled={disabled}>{label}</button>;
  return <div className="spreadsheet-toolbar" role="toolbar" aria-label="Spreadsheet editing tools">
    {button("Undo", onUndo, !state.undoStack.length)}{button("Redo", onRedo, !state.redoStack.length)}
    <span className="spreadsheet-toolbar-divider" aria-hidden="true" />
    {button("Save", onSave, state.saveStatus === "saving" || !Object.keys(state.pendingEdits).length)}
    {button("View", onView)}
    <span className="spreadsheet-toolbar-status" role="status">{state.saveStatus === "saving" ? "Saving…" : state.saveStatus === "unsaved" ? "Unsaved changes" : state.saveStatus === "failed" ? "Save failed" : "Saved"}</span>
  </div>;
}
