/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { ApiClient, type DriveIntegration } from "../src/api";

const integration = {
  connected: true,
  configured: true,
  canWrite: true,
} as DriveIntegration;

async function settleEffects() {
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("rendered upload controls", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/drive");
    host = document.createElement("div");
    document.body.appendChild(host);

    vi.spyOn(ApiClient.prototype, "refresh").mockResolvedValue({
      accessToken: "test-token",
      systemRole: "ADMIN",
    });
    vi.spyOn(ApiClient.prototype, "currentUser").mockResolvedValue({
      displayName: "Test user",
      email: "test@example.com",
      systemRole: "ADMIN",
      status: "ACTIVE",
      googleConnected: true,
    });
    vi.spyOn(ApiClient.prototype, "driveIntegration").mockResolvedValue(integration);
    vi.spyOn(ApiClient.prototype, "listNodes").mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(ApiClient.prototype, "breadcrumb").mockResolvedValue([]);
    vi.spyOn(ApiClient.prototype, "listFavorites").mockResolvedValue({ items: [] });
    vi.spyOn(ApiClient.prototype, "listFolderTree").mockResolvedValue({ items: [] });
    vi.spyOn(ApiClient.prototype, "upload").mockResolvedValue({ node: {} } as never);

    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("renders one shared multi-file picker used by sidebar and empty-state upload actions", async () => {
    await act(async () => root.render(createElement(App)));
    for (let attempt = 0; attempt < 5; attempt += 1) await settleEffects();

    const inputs = Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
    expect(inputs).toHaveLength(1);
    expect(inputs.every((input) => input.multiple)).toBe(true);

    const addFrom = document.querySelector<HTMLButtonElement>(".sidebar > .new-menu > button");
    const emptyFolderUpload = document.querySelector<HTMLButtonElement>(".content-state button.button-primary");
    expect(addFrom).not.toBeNull();
    expect(emptyFolderUpload).not.toBeNull();
    expect(document.querySelector(".topbar button.button-primary")).toBeNull();
    expect(document.querySelectorAll(".topbar > *")).toHaveLength(1);

    const picker = inputs[0]!;
    const pickerClick = vi.spyOn(picker, "click");
    await act(async () => {
      addFrom!.click();
      await Promise.resolve();
    });
    const uploadMenuItem = document.querySelector<HTMLButtonElement>("#add-drive-menu-popover [role=menuitem]");
    expect(uploadMenuItem).not.toBeNull();
    expect(document.querySelectorAll("#add-drive-menu-popover [role=menuitem]")).toHaveLength(3);
    expect(document.querySelector("#add-drive-menu-popover")?.textContent).toContain("Google Drive");
    uploadMenuItem!.click();
    emptyFolderUpload!.click();
    expect(pickerClick).toHaveBeenCalledTimes(2);

    const selectedFiles = ["A.docx", "B.xlsx", "C.json"].map((name) => new File([name], name));
    Object.defineProperty(picker, "files", { configurable: true, value: selectedFiles });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    for (let attempt = 0; attempt < 5; attempt += 1) await settleEffects();

    expect(document.querySelectorAll(".upload-queue-item")).toHaveLength(3);
    expect(vi.mocked(ApiClient.prototype.upload)).toHaveBeenCalledTimes(3);
    expect(picker.value).toBe("");
  });
});
