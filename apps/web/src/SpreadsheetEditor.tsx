import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ApiClient, ApiError, type SpreadsheetCell, type SpreadsheetCellValue, type SpreadsheetSheetModel, type SpreadsheetWorkbookModel } from "./api";
import { SpreadsheetToolbar } from "./SpreadsheetToolbar";
import { columnName } from "./spreadsheet-editor/selection";
import { createSpreadsheetEditorState, editKey, executeCellCommand, redo, undo, type SpreadsheetEditorState } from "./spreadsheet-editor/editor-state";
import type { RegisterWorkspaceActions, WorkspaceMode } from "./workspace";
import { useRecoveryDraft } from "./useEditorPersistence";

const api = new ApiClient();
const ROW_HEIGHT = 28;
const COLUMN_WIDTH = 120;
const ROW_HEADER_WIDTH = 48;
const COLUMN_HEADER_HEIGHT = 32;
const MAX_RENDER_ROWS = 100_000;

function cellValueType(value: SpreadsheetCellValue): SpreadsheetCell["valueType"] { if (value === null) return "blank"; if (typeof value === "boolean") return "boolean"; if (typeof value === "number") return "number"; return "string"; }
function displayValue(value: SpreadsheetCellValue): string { return value === null ? "" : typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value); }
function cellWithPending(base: SpreadsheetCell | undefined, pending: SpreadsheetCellValue | undefined, hasPending: boolean, address: string, row: number, column: number): SpreadsheetCell {
  if (!hasPending) return base ?? { address, row, column, value: null, valueType: "blank", displayValue: "", editable: true };
  return { ...(base ?? { address, row, column, value: null, valueType: "blank", displayValue: "", editable: true }), value: pending ?? null, valueType: cellValueType(pending ?? null), displayValue: displayValue(pending ?? null), formula: undefined, readonlyReason: undefined };
}
function parseInput(value: string): SpreadsheetCellValue { if (!value) return null; if (value === "TRUE" || value === "true") return true; if (value === "FALSE" || value === "false") return false; if (/^-?(?:\d+\.?\d*|\.\d+)$/u.test(value)) return Number(value); return value; }
function cellsByAddress(sheet: SpreadsheetSheetModel): Map<string, SpreadsheetCell> { return new Map(sheet.cells.map((cell) => [cell.address.toUpperCase(), cell])); }

export function SpreadsheetEditor({ nodeId, modelUrl, initialModel, mode, onModeChange, onRegisterActions, onDirtyChange }: { nodeId: string; modelUrl: string; initialModel: SpreadsheetWorkbookModel; mode: WorkspaceMode; onModeChange: (mode: WorkspaceMode) => void; onRegisterActions: RegisterWorkspaceActions; onDirtyChange: (dirty: boolean) => void }) {
  const [state, setState] = useState<SpreadsheetEditorState | null>(null);
  const [error, setError] = useState("");
  const saveGeneration = useRef(0);
  const pendingSignature = useRef("");
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [viewport, setViewport] = useState({ width: 900, height: 500, scrollTop: 0, scrollLeft: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const [loadingSheet, setLoadingSheet] = useState(false);
  useEffect(() => { let active = true; void api.getSpreadsheetSheet(modelUrl, initialModel.activeSheetId).then((sheet) => { if (active) setState(createSpreadsheetEditorState(initialModel, sheet)); }).catch(() => { if (active) setError("The spreadsheet sheet could not be loaded."); }); return () => { active = false; }; }, [initialModel, modelUrl]);
  useEffect(() => onDirtyChange(Boolean(state && Object.keys(state.pendingEdits).length)), [onDirtyChange, state]);
  useEffect(() => {
    const signature = JSON.stringify(state?.pendingEdits ?? {});
    if (signature !== pendingSignature.current) { pendingSignature.current = signature; saveGeneration.current += 1; }
  }, [state?.pendingEdits]);
  const sheet = state?.sheets[state.activeSheetId];
  const baseCells = useMemo(() => sheet ? cellsByAddress(sheet) : new Map<string, SpreadsheetCell>(), [sheet]);
  const selectedAddress = state ? `${columnName(state.selection.column)}${state.selection.row}` : "A1";
  const selectedBase = baseCells.get(selectedAddress);
  const selectedPendingKey = state ? editKey(state.activeSheetId, selectedAddress) : "";
  const selectedHasPending = Boolean(state && Object.prototype.hasOwnProperty.call(state.pendingEdits, selectedPendingKey));
  const selectedCell = state ? cellWithPending(selectedBase, state.pendingEdits[selectedPendingKey], selectedHasPending, selectedAddress, state.selection.row, state.selection.column) : null;
  const startEditing = useCallback((address: string, initial?: string) => { if (!state || mode !== "edit") return; const cell = baseCells.get(address); if (cell?.editable === false) return; setState((current) => current ? { ...current, editingCell: address } : current); setDraft(initial ?? (cell ? displayValue(cell.value) : "")); }, [baseCells, mode, state]);
  const commitDraft = useCallback(() => {
    if (!state?.editingCell) return;
    const cell = baseCells.get(state.editingCell); if (cell?.formula) { setState((current) => current ? { ...current, editingCell: null } : current); return; }
    const value = parseInput(draft); if (typeof value === "string" && value.startsWith("=")) { setError("Formula editing is not available yet."); return; }
    const key = editKey(state.activeSheetId, state.editingCell); const before = Object.prototype.hasOwnProperty.call(state.pendingEdits, key) ? state.pendingEdits[key] : undefined;
    setState((current) => current ? executeCellCommand(current, { key, before, after: value }) : current); setError(""); setState((current) => current ? { ...current, editingCell: null } : current);
  }, [baseCells, draft, state]);
  const moveSelection = useCallback((row: number, column: number) => setState((current) => current ? { ...current, selection: { row: Math.min(Math.max(1, row), Math.min(MAX_RENDER_ROWS, current.sheets[current.activeSheetId]?.dimensions.rowCount ?? 1)), column: Math.min(Math.max(1, column), current.sheets[current.activeSheetId]?.dimensions.columnCount ?? 1) } } : current), []);
  const save = useCallback(async () => {
    if (!state || !state.workbook.storageRevision || !Object.keys(state.pendingEdits).length || state.saveStatus === "saving" || state.saveStatus === "conflict") return;
    const generation = saveGeneration.current;
    setState((current) => current ? { ...current, saveStatus: "saving" } : current); setError("");
    const edits = Object.entries(state.pendingEdits).map(([key, value]) => { const [sheetId, cell] = key.split("\u0000"); return { sheetId, cell, value }; });
    try { const result = await api.saveSpreadsheet(nodeId, { expectedRevision: state.workbook.storageRevision, edits }); const freshSheet = await api.getSpreadsheetSheet(modelUrl, state.activeSheetId); setState((current) => current ? { ...current, workbook: result.model, sheets: { ...current.sheets, [freshSheet.id]: freshSheet }, pendingEdits: saveGeneration.current === generation ? {} : current.pendingEdits, undoStack: saveGeneration.current === generation ? [] : current.undoStack, redoStack: saveGeneration.current === generation ? [] : current.redoStack, editingCell: null, saveStatus: saveGeneration.current === generation ? "saved" : "unsaved" } : current); }
    catch (caught) { const conflict = caught instanceof ApiError && caught.status === 409; setState((current) => current ? { ...current, saveStatus: conflict ? "conflict" : "failed" } : current); setError(conflict ? "This file changed after you opened it." : caught instanceof Error ? caught.message : "The spreadsheet could not be saved."); }
  }, [modelUrl, nodeId, state]);
  const saveAsCopy = useCallback(async (name: string) => {
    if (!state?.workbook.storageRevision || !Object.keys(state.pendingEdits).length) return;
    const edits = Object.entries(state.pendingEdits).map(([key, value]) => { const [sheetId, cell] = key.split("\u0000"); return { sheetId, cell, value }; });
    await api.saveAsCopy(nodeId, { name, expectedRevision: state.workbook.storageRevision, edits });
  }, [nodeId, state]);
  const recoveryDraft = useRecoveryDraft({
    fileId: nodeId,
    engine: "SPREADSHEET",
    baseRevision: state?.workbook.storageRevision ?? "",
    isDirty: Boolean(state && Object.keys(state.pendingEdits).length),
    buildDraftPayload: useCallback(() => ({ pendingEdits: state?.pendingEdits ?? {}, activeSheetId: state?.activeSheetId ?? initialModel.activeSheetId }), [initialModel.activeSheetId, state?.activeSheetId, state?.pendingEdits]),
    applyRecoveredDraft: useCallback((payload: { pendingEdits: Record<string, SpreadsheetCellValue>; activeSheetId: string }) => { setState((current) => current ? { ...current, pendingEdits: payload.pendingEdits, activeSheetId: payload.activeSheetId, saveStatus: "unsaved" } : current); onModeChange("edit"); }, [onModeChange]),
  });
  const onGridKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!state) return;
    if (state.editingCell) { if (event.key === "Enter") { event.preventDefault(); commitDraft(); } else if (event.key === "Escape") { event.preventDefault(); setState((current) => current ? { ...current, editingCell: null } : current); } return; }
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "z") { event.preventDefault(); setState((current) => current ? (event.shiftKey ? redo(current) : undo(current)) : current); return; }
    if (modifier && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); return; }
    if (mode !== "edit") return;
    if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(state.selection.row - 1, state.selection.column); }
    else if (event.key === "ArrowDown" || event.key === "Enter") { event.preventDefault(); moveSelection(state.selection.row + 1, state.selection.column); }
    else if (event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey)) { event.preventDefault(); moveSelection(state.selection.row, state.selection.column - 1); }
    else if (event.key === "ArrowRight" || event.key === "Tab") { event.preventDefault(); moveSelection(state.selection.row, state.selection.column + 1); }
    else if ((event.key === "Delete" || event.key === "Backspace") && selectedCell?.editable !== false) { event.preventDefault(); const key = editKey(state.activeSheetId, selectedAddress); const before = Object.prototype.hasOwnProperty.call(state.pendingEdits, key) ? state.pendingEdits[key] : undefined; setState((current) => current ? executeCellCommand(current, { key, before, after: null }) : current); }
    else if (event.key.length === 1 && !modifier && selectedCell?.editable !== false) { event.preventDefault(); startEditing(selectedAddress, event.key); }
  }, [commitDraft, mode, moveSelection, save, selectedAddress, selectedCell?.editable, startEditing, state]);
  const loadSheet = useCallback(async (sheetId: string) => {
    if (!state || state.sheets[sheetId]) { setState((current) => current ? { ...current, activeSheetId: sheetId, selection: { row: 1, column: 1 } } : current); return; }
    setLoadingSheet(true); try { const loaded = await api.getSpreadsheetSheet(modelUrl, sheetId); setState((current) => current ? { ...current, activeSheetId: sheetId, sheets: { ...current.sheets, [sheetId]: loaded }, selection: { row: 1, column: 1 } } : current); } catch { setError("The worksheet could not be loaded."); } finally { setLoadingSheet(false); }
  }, [modelUrl, state]);
  const reload = useCallback(async () => { if (!state) return; if (Object.keys(state.pendingEdits).length && !window.confirm("Reload and discard unsaved changes?")) return; try { const workbook = await api.getSpreadsheetModel(modelUrl); const loaded = await api.getSpreadsheetSheet(modelUrl, workbook.activeSheetId); recoveryDraft.clearCurrentDraft(); setState(createSpreadsheetEditorState(workbook, loaded)); setError(""); } catch { setError("The spreadsheet could not be reloaded."); } }, [modelUrl, recoveryDraft, state]);
  const discardAndView = useCallback(() => {
    if (state && Object.keys(state.pendingEdits).length && !window.confirm("Discard unsaved changes?")) return;
    recoveryDraft.clearCurrentDraft();
    setState((current) => current ? { ...current, mode: "view", pendingEdits: {}, undoStack: [], redoStack: [], editingCell: null, saveStatus: "saved" } : current);
    onDirtyChange(false);
    onModeChange("view");
  }, [onDirtyChange, onModeChange, recoveryDraft, state]);
  useEffect(() => {
    onRegisterActions({ save: () => { void save(); }, saveAsCopy, view: discardAndView, canEdit: Boolean(state?.workbook.editable ?? initialModel.editable), canSave: Boolean(state && Object.keys(state.pendingEdits).length && state.saveStatus !== "saving" && state.saveStatus !== "conflict"), saving: state?.saveStatus === "saving" });
  }, [discardAndView, initialModel.editable, onRegisterActions, save, saveAsCopy, state]);
  if (!state || !sheet) return <div className="spreadsheet-loading" role="status">{loadingSheet ? "Loading worksheet…" : "Loading spreadsheet…"}</div>;
  const rows = Math.min(MAX_RENDER_ROWS, Math.max(1, sheet.dimensions.rowCount, state.selection.row)); const columns = Math.max(1, sheet.dimensions.columnCount, state.selection.column);
  const rowStart = Math.max(1, Math.floor(viewport.scrollTop / ROW_HEIGHT) - 4); const rowEnd = Math.min(rows, rowStart + Math.ceil(viewport.height / ROW_HEIGHT) + 8); const colStart = Math.max(1, Math.floor(viewport.scrollLeft / COLUMN_WIDTH) - 2); const colEnd = Math.min(columns, colStart + Math.ceil(viewport.width / COLUMN_WIDTH) + 4);
  const visibleRows = Array.from({ length: rowEnd - rowStart + 1 }, (_, index) => rowStart + index); const visibleColumns = Array.from({ length: colEnd - colStart + 1 }, (_, index) => colStart + index);
  const effective = (row: number, column: number) => { const address = `${columnName(column)}${row}`; const key = editKey(state.activeSheetId, address); const has = Object.prototype.hasOwnProperty.call(state.pendingEdits, key); return cellWithPending(baseCells.get(address), state.pendingEdits[key], has, address, row, column); };
  const styleFor = (cell: SpreadsheetCell): CSSProperties => ({ fontWeight: cell.style?.bold ? 700 : undefined, fontStyle: cell.style?.italic ? "italic" : undefined, textDecoration: cell.style?.underline ? "underline" : undefined, color: cell.style?.textColor ?? undefined, backgroundColor: cell.style?.fillColor ?? undefined, textAlign: cell.style?.horizontalAlign === "general" ? undefined : cell.style?.horizontalAlign, alignItems: cell.style?.verticalAlign === "top" ? "flex-start" : cell.style?.verticalAlign === "center" ? "center" : "flex-end" });
  return <div className="spreadsheet-editor"><SpreadsheetToolbar state={state} mode={mode} onUndo={() => setState((current) => current ? undo(current) : current)} onRedo={() => setState((current) => current ? redo(current) : current)} />
    {recoveryDraft.recovery && <div className="spreadsheet-editor-error" role="alert"><span>{recoveryDraft.recoveryIsOutdated ? "An older recovery draft is based on a previous file revision. Review it before saving; Save as copy is available." : "Unsaved changes from a previous session were found."}</span><button type="button" className="button" onClick={recoveryDraft.restore}>Restore</button><button type="button" className="button" onClick={recoveryDraft.discardRecovery}>Discard</button></div>}
    {error && <div className="spreadsheet-editor-error" role="alert">{error}<button type="button" className="button" onClick={() => void reload()}>Reload</button></div>}
    <div className="spreadsheet-tabs" role="tablist">{state.workbook.sheets.filter((descriptor) => !descriptor.hidden).map((descriptor) => <button key={descriptor.id} type="button" role="tab" aria-selected={descriptor.id === state.activeSheetId} className={descriptor.id === state.activeSheetId ? "active" : ""} onClick={() => void loadSheet(descriptor.id)}>{descriptor.name}</button>)}</div>
    <div ref={viewportRef} className="spreadsheet-grid-viewport" tabIndex={0} onKeyDown={onGridKeyDown} onScroll={(event) => setViewport({ width: event.currentTarget.clientWidth, height: event.currentTarget.clientHeight, scrollTop: event.currentTarget.scrollTop, scrollLeft: event.currentTarget.scrollLeft })} onFocus={() => setViewport((current) => ({ ...current, width: viewportRef.current?.clientWidth ?? current.width, height: viewportRef.current?.clientHeight ?? current.height }))}>
      <div className="spreadsheet-grid-canvas" style={{ width: ROW_HEADER_WIDTH + columns * COLUMN_WIDTH, height: COLUMN_HEADER_HEIGHT + rows * ROW_HEIGHT }}>
        <div className="spreadsheet-corner" />{visibleColumns.map((column) => <div key={`header-${column}`} className="spreadsheet-column-header" style={{ left: ROW_HEADER_WIDTH + (column - 1) * COLUMN_WIDTH }}>{columnName(column)}</div>)}
        {visibleRows.map((row) => <div key={`row-${row}`} className="spreadsheet-row-header" style={{ top: COLUMN_HEADER_HEIGHT + (row - 1) * ROW_HEIGHT }}>{row}</div>)}
        {visibleRows.flatMap((row) => visibleColumns.map((column) => { const cell = effective(row, column); const address = cell.address; const selected = address === selectedAddress; const editing = state.editingCell === address; return <div key={address} role="gridcell" aria-rowindex={row} aria-colindex={column} title={cell.formula ?? cell.readonlyReason ?? undefined} className={`spreadsheet-cell${selected ? " spreadsheet-cell-selected" : ""}${cell.editable === false ? " spreadsheet-cell-readonly" : ""}`} style={{ left: ROW_HEADER_WIDTH + (column - 1) * COLUMN_WIDTH, top: COLUMN_HEADER_HEIGHT + (row - 1) * ROW_HEIGHT, ...styleFor(cell) }} onClick={() => setState((current) => current ? { ...current, selection: { row, column } } : current)} onDoubleClick={() => startEditing(address)}>{editing ? <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commitDraft} onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { setComposing(false); setDraft(event.currentTarget.value); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitDraft(); } else if (event.key === "Escape") { event.preventDefault(); setState((current) => current ? { ...current, editingCell: null } : current); } }} aria-label={`Edit ${address}`} /> : cell.displayValue}</div>;}))}
      </div>
    </div>
    {composing && <span className="spreadsheet-composition-status" aria-live="polite">Editing…</span>}
  </div>;
}
