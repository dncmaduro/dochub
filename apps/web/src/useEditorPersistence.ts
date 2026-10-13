import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { listRecoveryDrafts, putRecoveryDraft, recoveryKey, removeRecoveryDraft, type RecoveryDraft } from "./recovery-drafts";

export type EditorPersistenceStatus = "clean" | "dirty" | "saving" | "save-failed" | "conflict" | "recovering";

export function useRecoveryDraft<TDraft>(options: {
  fileId: string;
  engine: string;
  baseRevision: string;
  isDirty: boolean;
  buildDraftPayload: () => TDraft;
  applyRecoveredDraft: (payload: TDraft) => void;
}) {
  const { fileId, engine, baseRevision, isDirty, buildDraftPayload, applyRecoveredDraft } = options;
  const [recovery, setRecovery] = useState<RecoveryDraft<TDraft> | null>(null);
  const [recoveryCandidates, setRecoveryCandidates] = useState<RecoveryDraft<TDraft>[]>([]);
  const draftKey = useRef("");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const previousKey = draftKey.current;
    draftKey.current = recoveryKey(fileId, engine, baseRevision);
    if (!isDirty && previousKey && previousKey !== draftKey.current) void removeRecoveryDraft(previousKey);
    let active = true;
    void listRecoveryDrafts<TDraft>(fileId).then((drafts) => {
      if (!active) return;
      const candidates = drafts.filter((draft) => draft.engine === engine).sort((left, right) => right.updatedAt - left.updatedAt);
      setRecoveryCandidates(candidates);
      setRecovery(candidates[0] ?? null);
    });
    return () => { active = false; };
  }, [baseRevision, engine, fileId, isDirty]);

  useEffect(() => {
    if (!isDirty) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void putRecoveryDraft({ fileId, engine, baseRevision, payload: buildDraftPayload() }); }, 1_250);
    return () => { if (timer.current !== null) window.clearTimeout(timer.current); };
  }, [baseRevision, buildDraftPayload, engine, fileId, isDirty]);

  useEffect(() => {
    const flush = () => { if (isDirty) void putRecoveryDraft({ fileId, engine, baseRevision, payload: buildDraftPayload() }); };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [baseRevision, buildDraftPayload, engine, fileId, isDirty]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (isDirty) { event.preventDefault(); event.returnValue = ""; } };
    if (isDirty) window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [isDirty]);

  const restore = useCallback(() => {
    if (!recovery) return;
    void removeRecoveryDraft(recovery.key);
    applyRecoveredDraft(recovery.payload);
    setRecovery(null);
  }, [applyRecoveredDraft, recovery]);
  const discardRecovery = useCallback(() => { if (recovery) void removeRecoveryDraft(recovery.key); setRecovery(null); }, [recovery]);
  const clearCurrentDraft = useCallback(() => { if (draftKey.current) void removeRecoveryDraft(draftKey.current); }, []);

  return { recovery, recoveryCandidates, recoveryIsOutdated: Boolean(recovery && recovery.baseRevision !== baseRevision), restore, discardRecovery, clearCurrentDraft, draftKey };
}

export function useEditorPersistence<TDraft, TResult extends { storageRevision?: string }>(options: {
  fileId: string;
  engine: string;
  baseRevision: string;
  isDirty: boolean;
  buildDraftPayload: () => TDraft;
  save: (payload: TDraft) => Promise<TResult>;
  applyRecoveredDraft: (payload: TDraft) => void;
  onSaved?: (result: TResult, allLocalChangesSaved: boolean) => void;
}) {
  const { isDirty, buildDraftPayload, save, onSaved } = options;
  const [status, setStatus] = useState<EditorPersistenceStatus>(isDirty ? "dirty" : "clean");
  const [error, setError] = useState("");
  const recoveryState = useRecoveryDraft(options);
  const { recovery, recoveryCandidates, recoveryIsOutdated, restore: restoreRecovery, discardRecovery, clearCurrentDraft } = recoveryState;
  const generation = useRef(0);
  const inFlight = useRef<Promise<TResult> | null>(null);

  useEffect(() => {
    if (!isDirty) return;
    generation.current += 1;
  }, [isDirty]);

  const requestSave = useCallback(() => {
    const visibleStatus = isDirty && (status === "clean" || status === "save-failed") ? "dirty" : status;
    if (!isDirty || visibleStatus === "saving" || visibleStatus === "conflict") return inFlight.current;
    const saveGeneration = generation.current;
    setStatus("saving");
    setError("");
    const request = save(buildDraftPayload());
    inFlight.current = request;
    void request.then((result) => {
      const allLocalChangesSaved = generation.current === saveGeneration;
      if (allLocalChangesSaved) clearCurrentDraft();
      setStatus(allLocalChangesSaved ? "clean" : "dirty");
      onSaved?.(result, allLocalChangesSaved);
    }).catch((caught: unknown) => {
      setStatus(caught instanceof ApiError && caught.status === 409 ? "conflict" : "save-failed");
      setError(caught instanceof Error ? caught.message : "The file could not be saved.");
    }).finally(() => { if (inFlight.current === request) inFlight.current = null; });
    return request;
  }, [buildDraftPayload, clearCurrentDraft, isDirty, onSaved, save, status]);

  const restore = useCallback(() => { setStatus("recovering"); restoreRecovery(); setStatus("dirty"); }, [restoreRecovery]);
  const reset = useCallback(() => { generation.current += 1; setStatus("clean"); setError(""); clearCurrentDraft(); }, [clearCurrentDraft]);
  const visibleStatus = isDirty && (status === "clean" || status === "save-failed") ? "dirty" : status;

  return { status: visibleStatus, error, recovery, recoveryCandidates, recoveryIsOutdated, requestSave, restore, discardRecovery, reset };
}
