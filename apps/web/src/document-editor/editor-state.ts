import type { DocumentBlock, DocumentModel } from "../api";
import { executeCommand, type DocumentCommand } from "./commands";

export type EditorMode = "view" | "edit";
export type SaveStatus = "saved" | "unsaved" | "saving" | "failed" | "conflict";

export interface BlockSelection {
  blockId: string;
  anchorOffset: number;
  focusOffset: number;
}

export interface DocumentEditorState {
  baselineModel: DocumentModel;
  currentModel: DocumentModel;
  dirtyBlockIds: Set<string>;
  undoStack: DocumentModel[];
  redoStack: DocumentModel[];
  mode: EditorMode;
  saveStatus: SaveStatus;
  selection: BlockSelection | null;
}

function editableBlockIds(blocks: DocumentBlock[], output: Set<string>): void {
  for (const block of blocks) {
    if ((block.type === "paragraph" || block.type === "heading" || block.type === "list-item") && block.editable !== false) output.add(block.id);
    if (block.type === "table") for (const row of block.rows) for (const cell of row.cells) editableBlockIds(cell.blocks, output);
  }
}

function blockValue(model: DocumentModel, id: string): DocumentBlock | null {
  const visit = (blocks: DocumentBlock[]): DocumentBlock | null => {
    for (const block of blocks) {
      if (block.id === id) return block;
      if (block.type === "table") for (const row of block.rows) for (const cell of row.cells) {
        const found = visit(cell.blocks);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(model.blocks);
}

function dirtyBlocks(baseline: DocumentModel, current: DocumentModel): Set<string> {
  const ids = new Set<string>();
  editableBlockIds(current.blocks, ids);
  const dirty = new Set<string>();
  for (const id of ids) if (JSON.stringify(blockValue(baseline, id)) !== JSON.stringify(blockValue(current, id))) dirty.add(id);
  return dirty;
}

export function createEditorState(model: DocumentModel): DocumentEditorState {
  return {
    baselineModel: model,
    currentModel: model,
    dirtyBlockIds: new Set(),
    undoStack: [],
    redoStack: [],
    mode: "view",
    saveStatus: "saved",
    selection: null,
  };
}

export function executeEditorCommand(state: DocumentEditorState, command: DocumentCommand): DocumentEditorState {
  const nextModel = executeCommand(state.currentModel, command);
  if (JSON.stringify(nextModel.blocks) === JSON.stringify(state.currentModel.blocks)) return state;
  return {
    ...state,
    currentModel: nextModel,
    dirtyBlockIds: dirtyBlocks(state.baselineModel, nextModel),
    undoStack: [...state.undoStack, state.currentModel],
    redoStack: [],
    saveStatus: "unsaved",
  };
}

export function undo(state: DocumentEditorState): DocumentEditorState {
  const previous = state.undoStack[state.undoStack.length - 1];
  if (!previous) return state;
  return { ...state, currentModel: previous, undoStack: state.undoStack.slice(0, -1), redoStack: [...state.redoStack, state.currentModel], dirtyBlockIds: dirtyBlocks(state.baselineModel, previous), saveStatus: "unsaved" };
}

export function redo(state: DocumentEditorState): DocumentEditorState {
  const next = state.redoStack[state.redoStack.length - 1];
  if (!next) return state;
  return { ...state, currentModel: next, redoStack: state.redoStack.slice(0, -1), undoStack: [...state.undoStack, state.currentModel], dirtyBlockIds: dirtyBlocks(state.baselineModel, next), saveStatus: "unsaved" };
}

export function replaceBaseline(state: DocumentEditorState, model: DocumentModel): DocumentEditorState {
  return { ...state, baselineModel: model, currentModel: model, dirtyBlockIds: new Set(), undoStack: [], redoStack: [], saveStatus: "saved", selection: null };
}

export function acceptSavedModel(
  state: DocumentEditorState,
  model: DocumentModel,
  savedModel: DocumentModel = state.currentModel,
  postSaveCommands: readonly DocumentCommand[] | null = null,
): DocumentEditorState {
  const hasPostSaveEdits = JSON.stringify(state.currentModel.blocks) !== JSON.stringify(savedModel.blocks);
  if (!hasPostSaveEdits) return replaceBaseline(state, model);
  // Replay commands against the server's normalized model rather than keeping
  // a stale pre-save tree. This preserves edits made while the save was in
  // flight without resurrecting old run metadata from the previous revision.
  const currentModel = postSaveCommands?.length
    ? postSaveCommands.reduce((current, command) => executeCommand(current, command), model)
    : { ...state.currentModel, storageRevision: model.storageRevision };
  const dirtyBlockIds = dirtyBlocks(model, currentModel);
  return { ...state, baselineModel: model, currentModel, dirtyBlockIds, undoStack: [], redoStack: [], saveStatus: dirtyBlockIds.size ? "unsaved" : "saved", selection: null };
}

export function restoreRecoveredModel(state: DocumentEditorState, model: DocumentModel): DocumentEditorState {
  const dirtyBlockIds = dirtyBlocks(state.baselineModel, model);
  return { ...state, currentModel: model, dirtyBlockIds, undoStack: [], redoStack: [], saveStatus: dirtyBlockIds.size ? "unsaved" : "saved" };
}

export function setSelection(state: DocumentEditorState, selection: BlockSelection | null): DocumentEditorState {
  return { ...state, selection };
}
