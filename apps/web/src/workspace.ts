export type WorkspaceMode = "view" | "edit";

export interface WorkspaceActions {
  save: () => void;
  view: () => void;
  canEdit: boolean;
  canSave: boolean;
  saving: boolean;
}

export type RegisterWorkspaceActions = (actions: WorkspaceActions) => void;
