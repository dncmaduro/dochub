import type { PresentationEditorState } from "./presentation-editor/editor-state";
import type { WorkspaceMode } from "./workspace";

export function PresentationToolbar({ state, mode, onUndo, onRedo, onBold, onItalic, onUnderline, onAlign, onFontSize, onZoom }: { state: PresentationEditorState; mode: WorkspaceMode; onUndo: () => void; onRedo: () => void; onBold: () => void; onItalic: () => void; onUnderline: () => void; onAlign: (alignment: "left" | "center" | "right" | "justified") => void; onFontSize: (size: number) => void; onZoom: (delta: number) => void }) {
  const editing = mode === "edit";
  return <div className="presentation-toolbar" role="toolbar" aria-label="Presentation tools">
    {editing ? <>
      <button type="button" className="presentation-tool-button" disabled={!state.history.length} onClick={onUndo}>Undo</button>
      <button type="button" className="presentation-tool-button" disabled={!state.future.length} onClick={onRedo}>Redo</button>
      <span className="presentation-toolbar-divider" />
      <button type="button" className="presentation-tool-button" onClick={onBold} aria-label="Bold"><strong>B</strong></button>
      <button type="button" className="presentation-tool-button" onClick={onItalic} aria-label="Italic"><em>I</em></button>
      <button type="button" className="presentation-tool-button" onClick={onUnderline} aria-label="Underline"><u>U</u></button>
      <input className="presentation-tool-size" type="number" min="6" max="96" step="1" aria-label="Font size" onChange={(event) => { const size = Number(event.target.value); if (Number.isFinite(size)) onFontSize(size); }} placeholder="Size" />
      <select className="presentation-tool-select" aria-label="Paragraph alignment" defaultValue="left" onChange={(event) => onAlign(event.target.value as "left" | "center" | "right" | "justified")}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="justified">Justify</option></select>
      <span className="presentation-toolbar-status">{state.saveStatus === "saving" ? "Saving…" : state.saveStatus === "error" ? "Save failed" : state.saveStatus === "dirty" ? "Unsaved changes" : "Saved"}</span>
    </> : <>
      <span className="presentation-toolbar-status">View</span>
    </>}
    <span className="presentation-zoom-controls"><button type="button" className="presentation-tool-button" onClick={() => onZoom(-0.25)} aria-label="Zoom out">−</button><span>{Math.round(state.zoom * 100)}%</span><button type="button" className="presentation-tool-button" onClick={() => onZoom(0.25)} aria-label="Zoom in">+</button></span>
  </div>;
}
