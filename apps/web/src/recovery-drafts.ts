export const EDITOR_DRAFT_RETENTION_DAYS = 7;
export const EDITOR_DRAFT_MAX_BYTES = 512 * 1024;
export const EDITOR_DRAFT_MAX_COUNT = 20;

export interface RecoveryDraft<T = unknown> {
  key: string;
  schemaVersion: 1;
  userId: string;
  fileId: string;
  engine: string;
  sessionId: string;
  baseRevision: string;
  payload: T;
  createdAt: number;
  updatedAt: number;
}

let authenticatedUserId: string | null = null;
let sessionId: string | null = null;

export function setRecoveryUser(userId: string | null) {
  authenticatedUserId = userId;
}

export function clearRecoveryUser() {
  authenticatedUserId = null;
}

function currentSessionId() {
  if (sessionId) return sessionId;
  try {
    const stored = window.sessionStorage.getItem("dochub.editor-session-id");
    sessionId = stored ?? crypto.randomUUID();
    window.sessionStorage.setItem("dochub.editor-session-id", sessionId);
  } catch {
    sessionId = crypto.randomUUID();
  }
  return sessionId;
}

export function recoveryUserId() {
  return authenticatedUserId;
}

export function recoveryKey(fileId: string, engine: string, baseRevision: string) {
  return [authenticatedUserId ?? "anonymous", fileId, engine, baseRevision, currentSessionId()].join("/");
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const request = indexedDB.open("dochub-editor-recovery", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("drafts", { keyPath: "key" });
      store.createIndex("userId", "userId");
      store.createIndex("fileId", "fileId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("drafts", mode);
    const result = operation(transaction.objectStore("drafts"));
    transaction.oncomplete = () => resolve(result && "result" in result ? (result as IDBRequest<T>).result : undefined);
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB operation failed"));
  });
}

export async function putRecoveryDraft<T>(draft: Omit<RecoveryDraft<T>, "key" | "schemaVersion" | "userId" | "sessionId" | "createdAt" | "updatedAt">) {
  const userId = recoveryUserId();
  if (!userId) return false;
  const key = recoveryKey(draft.fileId, draft.engine, draft.baseRevision);
  try {
    const serialized = JSON.stringify(draft.payload);
    if (new Blob([serialized]).size > EDITOR_DRAFT_MAX_BYTES) return false;
    const now = Date.now();
    const existing = await getRecoveryDraft<T>(key);
    await withStore("readwrite", (store) => store.put({ ...draft, key, schemaVersion: 1, userId, sessionId: currentSessionId(), createdAt: existing?.createdAt ?? now, updatedAt: now } satisfies RecoveryDraft<T>));
    await trimRecoveryDrafts(userId);
    return true;
  } catch {
    return false;
  }
}

export async function getRecoveryDraft<T>(key: string): Promise<RecoveryDraft<T> | null> {
  try {
    return (await withStore<RecoveryDraft<T>>("readonly", (store) => store.get(key))) ?? null;
  } catch {
    return null;
  }
}

export async function removeRecoveryDraft(key: string) {
  try { await withStore("readwrite", (store) => store.delete(key)); } catch { /* recovery is best effort */ }
}

export async function listRecoveryDrafts<T = unknown>(fileId: string): Promise<RecoveryDraft<T>[]> {
  const userId = recoveryUserId();
  if (!userId) return [] as RecoveryDraft<T>[];
  try {
    const db = await database();
    return await new Promise<RecoveryDraft<T>[]>((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite");
      const store = transaction.objectStore("drafts");
      const request = store.index("fileId").getAll(fileId);
      request.onsuccess = () => {
        const expiry = Date.now() - EDITOR_DRAFT_RETENTION_DAYS * 86_400_000;
        const drafts = request.result as RecoveryDraft<T>[];
        for (const draft of drafts) if (draft.userId === userId && draft.updatedAt < expiry) store.delete(draft.key);
        resolve(drafts.filter((draft) => draft.userId === userId && draft.updatedAt >= expiry));
      };
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    return [] as RecoveryDraft<T>[];
  }
}

async function trimRecoveryDrafts(userId: string) {
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite");
      const store = transaction.objectStore("drafts");
      const request = store.index("userId").getAll(userId);
      request.onsuccess = () => {
        const expiry = Date.now() - EDITOR_DRAFT_RETENTION_DAYS * 86_400_000;
        const drafts = (request.result as RecoveryDraft[]).sort((left, right) => right.updatedAt - left.updatedAt);
        for (const draft of drafts.slice(EDITOR_DRAFT_MAX_COUNT)) store.delete(draft.key);
        for (const draft of drafts.filter((item) => item.updatedAt < expiry)) store.delete(draft.key);
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch { /* recovery is best effort */ }
}

export async function clearRecoveryDraftsForUser(userId = recoveryUserId()) {
  if (!userId) return;
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("drafts", "readwrite");
      const request = transaction.objectStore("drafts").index("userId").getAllKeys(userId);
      request.onsuccess = () => { for (const key of request.result) transaction.objectStore("drafts").delete(key); };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch { /* recovery is best effort */ }
}
