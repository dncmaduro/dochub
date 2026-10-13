import { useEffect, useState } from "react";
import { ApiClient, type PresentationModel } from "./api";
import { PresentationEditor } from "./PresentationEditor";
import type { RegisterWorkspaceActions, WorkspaceMode } from "./workspace";

const api = new ApiClient();

export function PresentationViewer({ modelUrl, nodeId, mode, onModeChange, onRegisterActions, attempt, onReady, onError, onDirtyChange }: { modelUrl: string; nodeId: string; mode: WorkspaceMode; onModeChange: (mode: WorkspaceMode) => void; onRegisterActions: RegisterWorkspaceActions; attempt: number; onReady: () => void; onError: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [model, setModel] = useState<PresentationModel | null>(null);
  useEffect(() => {
    let active = true;
    void api.getPresentationModel(modelUrl).then((next) => { if (active) setModel(next); }).catch(() => { if (active) onError(); });
    return () => { active = false; };
  }, [attempt, modelUrl, onError]);
  return <div className="presentation-viewer" aria-busy={!model}>{model ? <PresentationEditor key={attempt} modelUrl={modelUrl} nodeId={nodeId} initialModel={model} mode={mode} onModeChange={onModeChange} onRegisterActions={onRegisterActions} onReady={onReady} onError={onError} onDirtyChange={onDirtyChange} /> : <div className="presentation-loading" role="status">Loading presentation…</div>}</div>;
}
