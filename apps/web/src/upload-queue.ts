export type UploadQueueStatus = "queued" | "uploading" | "success" | "failed";

export interface UploadQueueItem {
  id: string;
  idempotencyKey: string;
  file: File;
  destinationFolderId: string | null;
  status: UploadQueueStatus;
  progress: number;
  error: string | null;
}

export type UploadQueueItemUpdate = Partial<Pick<UploadQueueItem, "status" | "progress" | "error">>;

export interface UploadQueueRunOptions {
  concurrency?: number;
  isAuthorizationError?: (error: unknown) => boolean;
  getErrorMessage?: (error: unknown) => string;
  authorizationMessage?: string;
}

export interface UploadQueueRunResult {
  authorizationFailed: boolean;
}

export function createUploadQueueItems(
  files: readonly File[],
  destinationFolderId: string | null,
): UploadQueueItem[] {
  return files.map((file) => ({
    id: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    file,
    destinationFolderId,
    status: "queued",
    progress: 0,
    error: null,
  }));
}

/**
 * Run queued uploads with bounded concurrency. The caller owns the item state;
 * updates are emitted as each item transitions so File objects stay in memory
 * and are sent directly to the existing one-file upload endpoint.
 */
export async function runUploadQueue(
  items: readonly UploadQueueItem[],
  upload: (item: UploadQueueItem) => Promise<unknown>,
  update: (id: string, patch: UploadQueueItemUpdate) => void,
  options: UploadQueueRunOptions = {},
): Promise<UploadQueueRunResult> {
  const pending = items.filter((item) => item.status === "queued");
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 3));
  const isAuthorizationError = options.isAuthorizationError ?? (() => false);
  const getErrorMessage = options.getErrorMessage ?? ((error) => String(error));
  const authorizationMessage = options.authorizationMessage ?? "Authorization required.";
  const started = new Set<string>();
  let nextIndex = 0;
  let authorizationFailed = false;

  async function worker() {
    while (!authorizationFailed) {
      const item = pending[nextIndex++];
      if (!item) return;
      started.add(item.id);
      update(item.id, { status: "uploading", progress: 0, error: null });
      try {
        await upload(item);
        update(item.id, { status: "success", progress: 100, error: null });
      } catch (error) {
        const authorizationError = isAuthorizationError(error);
        update(item.id, {
          status: "failed",
          error: authorizationError ? authorizationMessage : getErrorMessage(error),
        });
        if (authorizationError) authorizationFailed = true;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()),
  );

  if (authorizationFailed) {
    for (const item of pending) {
      if (!started.has(item.id)) {
        update(item.id, { status: "failed", error: authorizationMessage });
      }
    }
  }

  return { authorizationFailed };
}
