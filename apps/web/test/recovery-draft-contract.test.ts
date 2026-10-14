// @vitest-environment jsdom
import { act, createElement, useCallback, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorPersistence, useRecoveryDraft } from "../src/useEditorPersistence";
import { listRecoveryDrafts, recoveryKey, removeRecoveryDraft, type RecoveryDraft } from "../src/recovery-drafts";

vi.mock("../src/recovery-drafts", () => ({
  listRecoveryDrafts: vi.fn(),
  putRecoveryDraft: vi.fn(),
  recoveryKey: vi.fn(() => "current-session-draft"),
  removeRecoveryDraft: vi.fn(),
}));

type DraftPayload = { content: string };
type HookResult = ReturnType<typeof useRecoveryDraft<DraftPayload>>;

let root: Root;
let latest: HookResult | null = null;
let persistence: ReturnType<typeof useEditorPersistence<{ content: string }, { storageRevision: string }>> | null = null;

function candidate(baseRevision: string): RecoveryDraft<DraftPayload> {
  return {
    key: "other-session-draft",
    schemaVersion: 1,
    userId: "user-1",
    fileId: "file-1",
    engine: "TEXT",
    sessionId: "other-session",
    baseRevision,
    payload: { content: "recovered" },
    createdAt: 1,
    updatedAt: 2,
  };
}

function Harness({ baseRevision, apply }: { baseRevision: string; apply: (payload: DraftPayload) => void }) {
  const result = useRecoveryDraft({
    fileId: "file-1",
    engine: "TEXT",
    baseRevision,
    isDirty: false,
    buildDraftPayload: () => ({ content: "current" }),
    applyRecoveredDraft: apply,
  });
  useEffect(() => { latest = result; });
  return null;
}

function PersistenceHarness({ draft, save, onSaved }: {
  draft: string;
  save: (payload: DraftPayload) => Promise<{ storageRevision: string }>;
  onSaved: (result: { storageRevision: string }, allLocalChangesSaved: boolean) => void;
}) {
  const buildDraftPayload = useCallback(() => ({ content: draft }), [draft]);
  const result = useEditorPersistence({
    fileId: "file-1",
    engine: "TEXT",
    baseRevision: "R1",
    isDirty: true,
    buildDraftPayload,
    save,
    applyRecoveredDraft: () => undefined,
    onSaved,
  });
  useEffect(() => { persistence = result; });
  return null;
}

async function render(baseRevision: string, apply: (payload: DraftPayload) => void) {
  await act(async () => {
    root.render(createElement(Harness, { baseRevision, apply }));
    await Promise.resolve();
  });
}

async function renderPersistence(draft: string, save: (payload: DraftPayload) => Promise<{ storageRevision: string }>, onSaved: (result: { storageRevision: string }, allLocalChangesSaved: boolean) => void) {
  await act(async () => {
    root.render(createElement(PersistenceHarness, { draft, save, onSaved }));
    await Promise.resolve();
  });
}

describe("recovery draft contract", () => {
  beforeEach(() => {
    latest = null;
    persistence = null;
    vi.mocked(recoveryKey).mockReturnValue("current-session-draft");
    vi.mocked(removeRecoveryDraft).mockReset();
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.clearAllMocks();
  });

  it("restores a same-revision draft without deleting it before an authoritative save", async () => {
    vi.mocked(listRecoveryDrafts).mockResolvedValue([candidate("R1")]);
    const apply = vi.fn();

    await render("R1", apply);

    expect(latest?.canRestoreRecovery).toBe(true);
    act(() => latest?.restore());
    expect(apply).toHaveBeenCalledWith({ content: "recovered" });
    expect(removeRecoveryDraft).not.toHaveBeenCalled();

    act(() => latest?.clearCurrentDraft());
    expect(removeRecoveryDraft).toHaveBeenCalledWith("current-session-draft");
    expect(removeRecoveryDraft).toHaveBeenCalledWith("other-session-draft");
  });

  it("does not offer or apply an outdated draft", async () => {
    vi.mocked(listRecoveryDrafts).mockResolvedValue([candidate("R1")]);
    const apply = vi.fn();

    await render("R2", apply);

    expect(latest?.recoveryIsOutdated).toBe(true);
    expect(latest?.canRestoreRecovery).toBe(false);
    act(() => latest?.restore());
    expect(apply).not.toHaveBeenCalled();
    expect(removeRecoveryDraft).not.toHaveBeenCalled();

    act(() => latest?.discardRecovery());
    expect(removeRecoveryDraft).toHaveBeenCalledTimes(1);
    expect(removeRecoveryDraft).toHaveBeenCalledWith("other-session-draft");
  });

  it("keeps the editor dirty when a later local edit races a save response", async () => {
    vi.mocked(listRecoveryDrafts).mockResolvedValue([]);
    let resolve!: (value: { storageRevision: string }) => void;
    const save = vi.fn(() => new Promise<{ storageRevision: string }>((done) => { resolve = done; }));
    const onSaved = vi.fn();

    await renderPersistence("B", save, onSaved);
    act(() => { void persistence?.requestSave(); });
    expect(persistence?.status).toBe("saving");

    await renderPersistence("C", save, onSaved);
    await act(async () => { resolve({ storageRevision: "R2" }); await Promise.resolve(); });

    expect(onSaved).toHaveBeenCalledWith({ storageRevision: "R2" }, false);
    expect(persistence?.status).toBe("dirty");
  });

  it("keeps a failed save distinguishable from ordinary unsaved changes", async () => {
    vi.mocked(listRecoveryDrafts).mockResolvedValue([]);
    const save = vi.fn().mockRejectedValue(new Error("offline"));

    await renderPersistence("B", save, vi.fn());
    act(() => { void persistence?.requestSave(); });
    await act(async () => { await Promise.resolve(); });

    expect(persistence?.status).toBe("save-failed");
  });
});
