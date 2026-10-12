import type { SpreadsheetCellValue, SpreadsheetSheetModel, SpreadsheetWorkbookModel } from "../api";

export interface SpreadsheetSelection { row: number; column: number; }
export interface SpreadsheetCellCommand { key: string; before: SpreadsheetCellValue | undefined; after: SpreadsheetCellValue; }
export interface SpreadsheetEditorState {
  mode: "view" | "edit";
  workbook: SpreadsheetWorkbookModel;
  sheets: Record<string, SpreadsheetSheetModel>;
  activeSheetId: string;
  selection: SpreadsheetSelection;
  editingCell: string | null;
  pendingEdits: Record<string, SpreadsheetCellValue>;
  undoStack: SpreadsheetCellCommand[];
  redoStack: SpreadsheetCellCommand[];
  saveStatus: "saved" | "unsaved" | "saving" | "failed";
}
export function editKey(sheetId: string, address: string): string { return `${sheetId}\u0000${address.toUpperCase()}`; }
export function createSpreadsheetEditorState(workbook: SpreadsheetWorkbookModel, sheet: SpreadsheetSheetModel): SpreadsheetEditorState {
  return { mode: "view", workbook, sheets: { [sheet.id]: sheet }, activeSheetId: sheet.id, selection: { row: 1, column: 1 }, editingCell: null, pendingEdits: {}, undoStack: [], redoStack: [], saveStatus: "saved" };
}
export function executeCellCommand(state: SpreadsheetEditorState, command: SpreadsheetCellCommand): SpreadsheetEditorState {
  const pendingEdits = { ...state.pendingEdits, [command.key]: command.after };
  return { ...state, pendingEdits, undoStack: [...state.undoStack, command], redoStack: [], saveStatus: "unsaved" };
}
function applyHistory(state: SpreadsheetEditorState, command: SpreadsheetCellCommand, undoing: boolean): SpreadsheetEditorState {
  const value = undoing ? command.before : command.after;
  const pendingEdits = { ...state.pendingEdits };
  if (value === undefined) delete pendingEdits[command.key]; else pendingEdits[command.key] = value;
  return { ...state, pendingEdits, saveStatus: Object.keys(pendingEdits).length ? "unsaved" : "saved" };
}
export function undo(state: SpreadsheetEditorState): SpreadsheetEditorState {
  const command = state.undoStack.at(-1); if (!command) return state;
  return { ...applyHistory(state, command, true), undoStack: state.undoStack.slice(0, -1), redoStack: [...state.redoStack, command] };
}
export function redo(state: SpreadsheetEditorState): SpreadsheetEditorState {
  const command = state.redoStack.at(-1); if (!command) return state;
  return { ...applyHistory(state, command, false), undoStack: [...state.undoStack, command], redoStack: state.redoStack.slice(0, -1) };
}
