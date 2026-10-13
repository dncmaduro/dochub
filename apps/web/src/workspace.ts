export type WorkspaceMode = "view" | "edit";

let activeEditorDirty = false;

export function setActiveEditorDirty(dirty: boolean) {
  activeEditorDirty = dirty;
}

export function confirmEditorNavigation(): boolean {
  return !activeEditorDirty || window.confirm("You have unsaved changes. Discard them and navigate?");
}

export interface WorkspaceActions {
  save: () => void;
  saveAsCopy: (name: string) => Promise<void>;
  view: () => void;
  canEdit: boolean;
  canSave: boolean;
  saving: boolean;
}

export type RegisterWorkspaceActions = (actions: WorkspaceActions) => void;
