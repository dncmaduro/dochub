import { useEffect, useState } from "react";
import { ApiClient, type TextFileModel } from "./api";
import { TextFileEditor } from "./TextFileEditor";
import type { RegisterWorkspaceActions, WorkspaceMode } from "./workspace";

const api = new ApiClient();

export function TextFileViewer({ modelUrl, nodeId, canEdit, mode, onModeChange, onRegisterActions, attempt, onReady, onError, onDirtyChange }: { modelUrl: string; nodeId: string; canEdit: boolean; mode: WorkspaceMode; onModeChange: (mode: WorkspaceMode) => void; onRegisterActions: RegisterWorkspaceActions; attempt: number; onReady: () => void; onError: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [model, setModel] = useState<TextFileModel | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void api.getTextModel(modelUrl).then((next) => {
      if (!active) return;
      setModel(next);
      onDirtyChange(false);
      onReady();
    }).catch(() => { if (active) onError(); });
    return () => { active = false; };
  }, [modelUrl, attempt, reload, onDirtyChange, onReady, onError]);
  return <div className="text-file-viewer" aria-busy={!model}>{model ? <TextFileEditor key={`${model.storageRevision ?? ""}-${reload}`} nodeId={nodeId} initialModel={model} canEdit={canEdit} mode={mode} onModeChange={onModeChange} onRegisterActions={onRegisterActions} onDirtyChange={onDirtyChange} onReload={() => setReload((value) => value + 1)} /> : <div className="text-file-loading" role="status">Loading text file…</div>}</div>;
}
