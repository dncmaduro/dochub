import type { DocumentAlignment } from "./api";
import type { DocumentEditorState } from "./document-editor/editor-state";
import type { WorkspaceMode } from "./workspace";

export function DocumentToolbar({
  state,
  mode,
  onUndo,
  onRedo,
  onFormat,
  onAlignment,
  onStyle,
  onFontSize,
}: {
  state: DocumentEditorState;
  mode: WorkspaceMode;
  onUndo: () => void;
  onRedo: () => void;
  onFormat: (format: "bold" | "italic" | "underline" | "strike") => void;
  onAlignment: (alignment: DocumentAlignment) => void;
  onStyle: (style: "normal" | "heading-1" | "heading-2" | "heading-3") => void;
  onFontSize: (fontSize: number | null) => void;
}) {
  if (mode === "view") return null;
  const disabled = !state.selection || state.selection.anchorOffset === state.selection.focusOffset;
  const commandButton = (label: string, action: () => void, isDisabled = false) => <button type="button" className="document-tool-button" aria-label={label} title={label} disabled={isDisabled} onMouseDown={(event) => event.preventDefault()} onClick={action}>{label}</button>;
  return <div className="document-toolbar" role="toolbar" aria-label="Document editing tools">
    {commandButton("Undo", onUndo, state.undoStack.length === 0)}
    {commandButton("Redo", onRedo, state.redoStack.length === 0)}
    <span className="document-toolbar-divider" aria-hidden="true" />
    <select aria-label="Paragraph style" value={state.selection ? "" : ""} onChange={(event) => onStyle(event.target.value as "normal" | "heading-1" | "heading-2" | "heading-3")} defaultValue="">
      <option value="" disabled>Style</option><option value="normal">Normal</option><option value="heading-1">H1</option><option value="heading-2">H2</option><option value="heading-3">H3</option>
    </select>
    {commandButton("Bold", () => onFormat("bold"), disabled)}
    {commandButton("Italic", () => onFormat("italic"), disabled)}
    {commandButton("Underline", () => onFormat("underline"), disabled)}
    {commandButton("Strikethrough", () => onFormat("strike"), disabled)}
    <select aria-label="Font size" defaultValue="" disabled={disabled} onChange={(event) => onFontSize(event.target.value ? Number(event.target.value) : null)}>
      <option value="">Size</option><option value="10">10</option><option value="11">11</option><option value="12">12</option><option value="14">14</option><option value="16">16</option><option value="18">18</option><option value="24">24</option>
    </select>
    {(["left", "center", "right", "justified"] as DocumentAlignment[]).map((alignment) => commandButton(`Align ${alignment}`, () => onAlignment(alignment), !state.selection))}
    <span className="document-toolbar-status" role="status">{state.saveStatus === "saving" ? "Saving…" : state.saveStatus === "unsaved" ? "Unsaved changes" : state.saveStatus === "failed" ? "Save failed" : "Saved"}</span>
  </div>;
}
