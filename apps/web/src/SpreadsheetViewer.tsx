import { useEffect, useState } from "react";
import { ApiClient, type SpreadsheetWorkbookModel } from "./api";
import { SpreadsheetEditor } from "./SpreadsheetEditor";

const api = new ApiClient();
export function SpreadsheetViewer({ modelUrl, nodeId, canEdit, attempt, onReady, onError, onDirtyChange }: { modelUrl: string; nodeId: string; canEdit: boolean; attempt: number; onReady: () => void; onError: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [model, setModel] = useState<SpreadsheetWorkbookModel | null>(null);
  useEffect(() => {
    let active = true;
    void api.getSpreadsheetModel(modelUrl).then((next) => { if (!active) return; setModel(next); onDirtyChange(false); onReady(); }).catch(() => { if (active) onError(); });
    return () => { active = false; };
  }, [modelUrl, attempt, onDirtyChange, onReady, onError]);
  return <div className="spreadsheet-viewer" aria-busy={!model}>{model ? <SpreadsheetEditor key={`${model.id}-${model.storageRevision ?? ""}`} nodeId={nodeId} modelUrl={modelUrl} initialModel={model} canEdit={canEdit && model.editable} onDirtyChange={onDirtyChange} /> : <div className="spreadsheet-loading" role="status">Loading spreadsheet…</div>}</div>;
}
