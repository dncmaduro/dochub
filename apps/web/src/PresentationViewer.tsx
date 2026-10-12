import { useEffect, useState } from "react";
import { ApiClient, type PresentationModel } from "./api";
import { PresentationEditor } from "./PresentationEditor";

const api = new ApiClient();

export function PresentationViewer({ modelUrl, nodeId, canEdit, attempt, onReady, onError, onDirtyChange }: { modelUrl: string; nodeId: string; canEdit: boolean; attempt: number; onReady: () => void; onError: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [model, setModel] = useState<PresentationModel | null>(null);
  useEffect(() => {
    let active = true;
    void api.getPresentationModel(modelUrl).then((next) => { if (active) setModel(next); }).catch(() => { if (active) onError(); });
    return () => { active = false; };
  }, [attempt, modelUrl, onError]);
  return <div className="presentation-viewer" aria-busy={!model}>{model ? <PresentationEditor key={attempt} modelUrl={modelUrl} nodeId={nodeId} initialModel={model} canEdit={canEdit} onReady={onReady} onError={onError} onDirtyChange={onDirtyChange} /> : <div className="presentation-loading" role="status">Loading presentation…</div>}</div>;
}
