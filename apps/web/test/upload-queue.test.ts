import { describe, expect, it } from "vitest";
import {
  createUploadQueueItems,
  runUploadQueue,
  type UploadQueueItem,
} from "../src/upload-queue";

function files(names: readonly string[]) {
  return names.map((name) => new File([name], name, { type: "application/octet-stream" }));
}

function state(items: UploadQueueItem[]) {
  return new Map(items.map((item) => [item.id, item]));
}

describe("upload queue", () => {
  it("keeps selection order and never exceeds the concurrency limit", async () => {
    const items = createUploadQueueItems(files(["a.bin", "b.bin", "c.bin", "d.bin", "e.bin", "f.bin", "g.bin", "h.bin"]), "folder-a");
    const started: string[] = [];
    const updates = state(items);
    let active = 0;
    let maximumActive = 0;

    await runUploadQueue(
      items,
      async (item) => {
        started.push(item.file.name);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, item.file.name === "a.bin" ? 15 : 2));
        active -= 1;
      },
      (id, patch) => updates.set(id, { ...updates.get(id)!, ...patch }),
      { concurrency: 3 },
    );

    expect(maximumActive).toBe(3);
    expect(started).toEqual(["a.bin", "b.bin", "c.bin", "d.bin", "e.bin", "f.bin", "g.bin", "h.bin"]);
    expect([...updates.values()].every((item) => item.status === "success")).toBe(true);
  });

  it("continues after an ordinary per-file failure", async () => {
    const items = createUploadQueueItems(files(["a.bin", "b.bin", "c.bin"]), "folder-a");
    const updates = state(items);

    await runUploadQueue(
      items,
      async (item) => {
        if (item.file.name === "b.bin") throw new Error("validation failed");
      },
      (id, patch) => updates.set(id, { ...updates.get(id)!, ...patch }),
      { concurrency: 3, getErrorMessage: (error) => String(error instanceof Error ? error.message : error) },
    );

    expect([...updates.values()].map((item) => item.status)).toEqual(["success", "failed", "success"]);
    expect(updates.get(items[1]!.id)?.error).toBe("validation failed");
  });

  it("stops launching queued items after an authorization failure", async () => {
    const items = createUploadQueueItems(files(["a.bin", "b.bin", "c.bin", "d.bin", "e.bin"]), "folder-a");
    const updates = state(items);
    const started: string[] = [];

    await runUploadQueue(
      items,
      async (item) => {
        started.push(item.file.name);
        if (item.file.name === "a.bin") throw { status: 401 };
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      (id, patch) => updates.set(id, { ...updates.get(id)!, ...patch }),
      { concurrency: 3, isAuthorizationError: (error) => typeof error === "object" && error !== null && "status" in error && error.status === 401, authorizationMessage: "Sign in again." },
    );

    expect(started).not.toContain("d.bin");
    expect(started).not.toContain("e.bin");
    expect(updates.get(items[3]!.id)).toMatchObject({ status: "failed", error: "Sign in again." });
    expect(updates.get(items[4]!.id)).toMatchObject({ status: "failed", error: "Sign in again." });
  });

  it("retries only failed items and keeps their original destination", async () => {
    const items = createUploadQueueItems(files(["ok.bin", "retry.bin"]), "folder-a");
    const updates = state(items);
    const calls: string[] = [];

    await runUploadQueue(
      items,
      async (item) => {
        calls.push(item.file.name);
        if (item.file.name === "retry.bin") throw new Error("temporary failure");
      },
      (id, patch) => updates.set(id, { ...updates.get(id)!, ...patch }),
      { concurrency: 1 },
    );

    const retryItems = items
      .map((item) => updates.get(item.id)!)
      .filter((item) => item.status === "failed")
      .map((item) => ({ ...item, status: "queued" as const, error: null }));
    await runUploadQueue(
      retryItems,
      async (item) => {
        calls.push(`${item.file.name}:${item.destinationFolderId}`);
      },
      (id, patch) => updates.set(id, { ...updates.get(id)!, ...patch }),
      { concurrency: 1 },
    );

    expect(calls).toEqual(["ok.bin", "retry.bin", "retry.bin:folder-a"]);
    expect(updates.get(items[0]!.id)?.status).toBe("success");
  });

  it("accepts arbitrary files without client-side format filtering", () => {
    const names = ["test.docx", "test.xlsx", "test.pptx", "test.csv", "test.txt", "test.md", "test.json", "test.xml", "test.pdf", "test.png", "test.bin"];
    const items = createUploadQueueItems(files(names), "folder-a");

    expect(items.map((item) => item.file.name)).toEqual(names);
    expect(items.every((item) => item.status === "queued")).toBe(true);
  });

  it("keeps the captured destination when the current folder changes", async () => {
    const items = createUploadQueueItems(files(["a.bin", "b.bin", "c.bin"]), "folder-a");
    const destinations: Array<string | null> = [];
    let currentFolder = "folder-a";

    await runUploadQueue(
      items,
      async (item) => {
        destinations.push(item.destinationFolderId);
        currentFolder = "folder-b";
      },
      () => undefined,
      { concurrency: 1 },
    );

    expect(currentFolder).toBe("folder-b");
    expect(destinations).toEqual(["folder-a", "folder-a", "folder-a"]);
  });
});
