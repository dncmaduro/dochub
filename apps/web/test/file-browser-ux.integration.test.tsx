/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { ApiClient, type DriveIntegration, type Node, type NodeTreeItem } from "../src/api";

const integration = {
  connected: true,
  configured: true,
  canWrite: true,
} as DriveIntegration;

const folder: Node = {
  id: "folder-1",
  parentId: null,
  type: "FOLDER",
  name: "Project",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastModified: { at: "2026-01-01T00:00:00.000Z", actor: { type: "USER", displayName: "Editor" } },
  capabilities: ["VIEW", "PREVIEW"],
};

const file: Node = {
  id: "file-1",
  parentId: null,
  type: "FILE",
  name: "README.txt",
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  lastModified: { at: "2026-01-02T00:00:00.000Z", actor: { type: "SYSTEM", displayName: null } },
  capabilities: ["VIEW", "PREVIEW", "DOWNLOAD"],
};

const rootTree: NodeTreeItem[] = [
  { id: folder.id, parentId: null, name: folder.name, type: "FOLDER" },
  { id: file.id, parentId: null, name: file.name, type: "FILE" },
];

async function settleEffects() {
  await act(async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settleEffects();
}

function pointerEvent(type: string, clientX: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    pointerId: { value: 1 },
  });
  return event;
}

describe("file browser UX", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/drive");
    host = document.createElement("div");
    document.body.appendChild(host);
    vi.spyOn(ApiClient.prototype, "refresh").mockResolvedValue({
      accessToken: "test-token",
      systemRole: "DOCUMENT_MANAGER",
    });
    vi.spyOn(ApiClient.prototype, "currentUser").mockResolvedValue({
      id: "user-1",
      displayName: "Test user",
      email: "test@example.com",
      systemRole: "DOCUMENT_MANAGER",
      status: "ACTIVE",
      googleConnected: true,
    });
    vi.spyOn(ApiClient.prototype, "driveIntegration").mockResolvedValue(integration);
    vi.spyOn(ApiClient.prototype, "listNodes").mockResolvedValue({ items: [folder, file], nextCursor: null });
    vi.spyOn(ApiClient.prototype, "breadcrumb").mockResolvedValue([]);
    vi.spyOn(ApiClient.prototype, "listFavorites").mockResolvedValue({ items: [] });
    vi.spyOn(ApiClient.prototype, "listNodeTree").mockImplementation(async (parentId) => ({
      items: parentId === folder.id
        ? [{ id: "nested-file", parentId: folder.id, name: "nested.txt", type: "FILE" }]
        : rootTree,
    }));
    vi.spyOn(ApiClient.prototype, "getNode").mockResolvedValue(file);
    vi.spyOn(ApiClient.prototype, "recordRecent").mockResolvedValue();
    vi.spyOn(ApiClient.prototype, "createFilePreviewSession").mockResolvedValue({
      nodeId: file.id,
      previewable: false,
      preview: { kind: "unavailable" },
      contentUrl: null,
      engine: null,
      capabilities: { download: true },
    } as never);
    vi.spyOn(ApiClient.prototype, "moveToTrash").mockResolvedValue({ operation: { id: "trash-1" } });
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  async function renderApp() {
    await act(async () => {
      root.render(createElement(App));
      await Promise.resolve();
    });
    await settleEffects();
  }

  function sortButtons() {
    return Array.from(document.querySelectorAll<HTMLButtonElement>(".sort-controls button"));
  }

  it("uses shared toolbar sort controls in list and grid views without sortable headers or attribution", async () => {
    await renderApp();

    expect(sortButtons()).toHaveLength(2);
    expect(document.querySelectorAll(".file-table thead button")).toHaveLength(0);
    expect(Array.from(document.querySelectorAll(".file-table thead th")).map((header) => header.textContent?.trim())).toEqual(["Name", "Type", "Last modified", "Actions"]);
    expect(document.body.textContent).not.toContain("Modified by");
    expect(document.body.textContent).not.toContain("Not provided by Google Drive");

    const gridButton = document.querySelectorAll<HTMLButtonElement>(".view-toggle button")[1];
    expect(gridButton).toBeDefined();
    await click(gridButton!);
    expect(document.querySelector(".file-grid")).not.toBeNull();
    expect(sortButtons()).toHaveLength(2);
  });

  it("toggles each sort field deterministically and keeps URL-backed state", async () => {
    await renderApp();

    const [name, lastModified] = sortButtons();
    expect(name?.textContent).toContain("↑");
    expect(lastModified?.textContent).not.toContain("↑");
    expect(name?.getAttribute("aria-label")).toContain("descending");

    await click(name!);
    expect(window.location.search).toBe("?sortBy=name&sortDirection=desc");
    expect(sortButtons()[0]?.textContent).toContain("↓");

    await click(sortButtons()[0]!);
    expect(window.location.search).toBe("");
    expect(sortButtons()[0]?.textContent).toContain("↑");

    await click(sortButtons()[1]!);
    expect(window.location.search).toBe("?sortBy=lastModified&sortDirection=desc");
    expect(sortButtons()[1]?.textContent).toContain("↓");

    await click(sortButtons()[1]!);
    expect(window.location.search).toBe("?sortBy=lastModified&sortDirection=asc");
    expect(sortButtons()[1]?.textContent).toContain("↑");

    await click(sortButtons()[1]!);
    expect(window.location.search).toBe("?sortBy=lastModified&sortDirection=desc");
    expect(ApiClient.prototype.listNodes).toHaveBeenLastCalledWith(
      null,
      "lastModified",
      "desc",
      expect.any(AbortSignal),
    );

    await act(async () => root.unmount());
    root = createRoot(host);
    await renderApp();
    expect(sortButtons()[1]?.textContent).toContain("↓");
  });

  it("loads file leaves in the sidebar tree and reuses the file-open path", async () => {
    await renderApp();

    expect(document.querySelector(".folder-tree-actions")).toBeNull();
    const links = Array.from(document.querySelectorAll<HTMLButtonElement>(".folder-tree-link"));
    const folderLink = links.find((link) => link.textContent?.includes(folder.name));
    const fileLink = links.find((link) => link.textContent?.includes(file.name));
    expect(folderLink).toBeDefined();
    expect(fileLink).toBeDefined();
    expect(fileLink?.closest(".folder-tree-row")?.querySelector("button.folder-tree-toggle")).toBeNull();

    const folderToggle = folderLink?.closest(".folder-tree-row")?.querySelector<HTMLButtonElement>("button.folder-tree-toggle");
    expect(folderToggle).toBeDefined();
    await click(folderToggle!);
    expect(ApiClient.prototype.listNodeTree).toHaveBeenCalledWith(folder.id);
    expect(document.body.textContent).toContain("nested.txt");

    await click(fileLink!);
    expect(ApiClient.prototype.getNode).toHaveBeenCalledWith(file.id);
  });

  it("shows the folder trash action only to administrators and confirms subtree deletion", async () => {
    vi.mocked(ApiClient.prototype.refresh).mockResolvedValue({
      accessToken: "test-token",
      systemRole: "ADMIN",
    });
    vi.mocked(ApiClient.prototype.currentUser).mockResolvedValue({
      id: "admin-1",
      displayName: "Administrator",
      email: "admin@example.com",
      systemRole: "ADMIN",
      status: "ACTIVE",
      googleConnected: true,
    });
    await renderApp();

    const action = document.querySelector<HTMLButtonElement>(".folder-tree-actions");
    expect(action).not.toBeNull();
    await click(action!);
    const menuItem = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent?.includes("Move to Trash"));
    expect(menuItem).toBeDefined();
    await click(menuItem!);
    expect(document.body.textContent).toContain("This folder and all files and subfolders inside it will be moved to Trash.");

    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>(".confirm-dialog .button-danger"))[0];
    expect(confirm).toBeDefined();
    await click(confirm!);
    expect(ApiClient.prototype.moveToTrash).toHaveBeenCalledWith(folder.id);
  });

  it("resizes the sidebar with Pointer Events and restores a validated local preference", async () => {
    window.localStorage.setItem("dochub.sidebar-width", "not-a-number");
    await renderApp();

    const shell = document.querySelector<HTMLElement>(".app-shell");
    const handle = document.querySelector<HTMLElement>(".sidebar-resize-handle");
    expect(shell?.style.getPropertyValue("--sidebar-width")).toBe("216px");
    expect(handle).not.toBeNull();

    await act(async () => {
      handle!.dispatchEvent(pointerEvent("pointerdown", 100));
      window.dispatchEvent(pointerEvent("pointermove", 180));
      window.dispatchEvent(pointerEvent("pointerup", 180));
      await Promise.resolve();
    });
    expect(shell?.style.getPropertyValue("--sidebar-width")).toBe("296px");
    expect(window.localStorage.getItem("dochub.sidebar-width")).toBe("296");
    expect(document.body.classList.contains("is-resizing-sidebar")).toBe(false);
  });
});
