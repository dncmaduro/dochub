/** @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentEditor } from "../src/DocumentEditor";
import { ApiClient, type DocumentModel, type DocumentParagraphBlock } from "../src/api";

vi.mock("../src/useEditorPersistence", () => ({
  useRecoveryDraft: () => ({
    recovery: null,
    recoveryIsOutdated: false,
    canRestoreRecovery: false,
    restore: vi.fn(),
    discardRecovery: vi.fn(),
    clearCurrentDraft: vi.fn(),
  }),
}));

type EditorActions = { save: () => void; canSave: boolean };

let root: Root;
let host: HTMLDivElement;
let actions: EditorActions | null = null;
let onDirtyChange: ReturnType<typeof vi.fn>;

function paragraph(id: string, text: string): DocumentParagraphBlock {
  return {
    type: "paragraph",
    id,
    styleId: null,
    editable: true,
    alignment: "left",
    spacingBeforePt: 0,
    spacingAfterPt: 0,
    lineSpacing: null,
    indentLeftPt: 0,
    indentRightPt: 0,
    firstLineIndentPt: 0,
    content: [{
      kind: "text",
      id: `${id}-run`,
      text,
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      fontSize: null,
      fontFamily: null,
      color: null,
      verticalAlign: "baseline",
      link: null,
    }],
  };
}

function documentModel(revision: string, text: string): DocumentModel {
  return { version: 1, editable: true, storageRevision: revision, blocks: [paragraph("paragraph-1", text)] };
}

function tableModel(revision: string, text: string): DocumentModel {
  return {
    version: 1,
    editable: true,
    storageRevision: revision,
    blocks: [{
      type: "table",
      id: "table-1",
      columnWidthsPx: [200],
      rows: [{
        id: "row-1",
        cells: [{
          id: "cell-1",
          widthPx: 200,
          backgroundColor: null,
          borders: {},
          blocks: [paragraph("cell-paragraph-1", text)],
        }],
      }],
    }],
  };
}

async function render(initialModel: DocumentModel) {
  await act(async () => {
    root.render(createElement(DocumentEditor, {
      nodeId: "node-1",
      modelUrl: "/nodes/node-1/document",
      initialModel,
      mode: "edit",
      onModeChange: vi.fn(),
      onRegisterActions: (next) => { actions = next; },
      onDirtyChange,
      view: () => null,
    }));
    await Promise.resolve();
  });
}

function textarea(): HTMLTextAreaElement {
  const element = host.querySelector<HTMLTextAreaElement>("textarea");
  if (!element) throw new Error("Expected an editable textarea");
  return element;
}

async function dispatchInput(element: HTMLTextAreaElement, value: string, isComposing = false) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
    const event = new Event("input", { bubbles: true });
    Object.defineProperty(event, "isComposing", { value: isComposing });
    element.dispatchEvent(event);
    await Promise.resolve();
  });
}

async function dispatchComposition(element: HTMLTextAreaElement, type: "compositionstart" | "compositionupdate" | "compositionend", value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: value }));
    await Promise.resolve();
  });
}

async function dispatchBlur(element: HTMLTextAreaElement) {
  await act(async () => {
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await Promise.resolve();
  });
}

async function save() {
  expect(actions).not.toBeNull();
  await act(async () => {
    actions!.save();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DOCX editor input recovery", () => {
  beforeEach(() => {
    actions = null;
    onDirtyChange = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(ApiClient.prototype, "saveDocument");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("accepts normal typing after an authoritative paragraph save/rebase", async () => {
    vi.mocked(ApiClient.prototype.saveDocument).mockResolvedValue({ storageRevision: "R2", model: documentModel("R2", "saved") });
    await render(documentModel("R1", "before"));

    await dispatchInput(textarea(), "saved");
    expect(actions?.canSave).toBe(true);
    await save();
    expect(textarea().value).toBe("saved");

    await dispatchInput(textarea(), "saved again");
    expect(textarea().value).toBe("saved again");
    expect(actions?.canSave).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("keeps a table-cell textarea editable after save/rebase", async () => {
    vi.mocked(ApiClient.prototype.saveDocument).mockResolvedValue({ storageRevision: "R2", model: tableModel("R2", "saved cell") });
    await render(tableModel("R1", "before cell"));

    await dispatchInput(textarea(), "saved cell");
    await save();
    await dispatchInput(textarea(), "saved cell again");

    expect(textarea().value).toBe("saved cell again");
    expect(actions?.canSave).toBe(true);
  });

  it("recovers an interrupted composition on blur before accepting normal input", async () => {
    await render(documentModel("R1", "xin"));

    await dispatchComposition(textarea(), "compositionstart", "xin");
    await dispatchComposition(textarea(), "compositionupdate", "xin chào");
    await dispatchBlur(textarea());
    await dispatchInput(textarea(), "xin chào bạn");

    expect(textarea().value).toBe("xin chào bạn");
    expect(actions?.canSave).toBe(true);
  });

  it("commits a normal IME lifecycle exactly once", async () => {
    vi.mocked(ApiClient.prototype.saveDocument).mockResolvedValue({ storageRevision: "R2", model: documentModel("R2", "xin đ") });
    await render(documentModel("R1", "xin"));

    await dispatchComposition(textarea(), "compositionstart", "xin");
    await dispatchComposition(textarea(), "compositionupdate", "xin đ");
    await dispatchComposition(textarea(), "compositionend", "xin đ");
    await dispatchInput(textarea(), "xin đ");
    await save();

    const savedBlocks = vi.mocked(ApiClient.prototype.saveDocument).mock.calls[0]?.[1].blocks as Array<{ content: Array<{ text: string }> }>;
    expect(savedBlocks[0]?.content.map((run) => run.text).join("")).toBe("xin đ");
  });

  it("uses the textarea caret after rebase instead of a pre-save semantic selection", async () => {
    vi.mocked(ApiClient.prototype.saveDocument).mockResolvedValue({ storageRevision: "R2", model: documentModel("R2", "server") });
    await render(documentModel("R1", "abcdef"));

    textarea().setSelectionRange(1, 5);
    await act(async () => { textarea().dispatchEvent(new Event("select", { bubbles: true })); await Promise.resolve(); });
    await dispatchInput(textarea(), "edited");
    await save();

    textarea().focus();
    textarea().setSelectionRange(3, 3);
    await dispatchInput(textarea(), "serXver");
    expect(textarea().value).toBe("serXver");
  });

  it("synchronizes a valid input after benign extension-like DOM mutation", async () => {
    await render(documentModel("R1", "before"));

    textarea().setAttribute("data-extension-marker", "present");
    await dispatchInput(textarea(), "extension value");

    expect(textarea().getAttribute("data-extension-marker")).toBe("present");
    expect(textarea().value).toBe("extension value");
    expect(actions?.canSave).toBe(true);
  });

  it("replays an edit made while a save is in flight and accepts the next input", async () => {
    let resolveSave!: (result: { storageRevision: string; model: DocumentModel }) => void;
    vi.mocked(ApiClient.prototype.saveDocument).mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    await render(documentModel("R1", "before"));

    await dispatchInput(textarea(), "saved");
    expect(actions?.canSave).toBe(true);
    actions!.save();
    await dispatchInput(textarea(), "saved later");
    await act(async () => { resolveSave({ storageRevision: "R2", model: documentModel("R2", "saved") }); await Promise.resolve(); });
    expect(textarea().value).toBe("saved later");

    await dispatchInput(textarea(), "saved later again");
    expect(textarea().value).toBe("saved later again");
    expect(actions?.canSave).toBe(true);
  });

  it("rebases real composition text typed during a save without requiring compositionend", async () => {
    let resolveSave!: (result: { storageRevision: string; model: DocumentModel }) => void;
    vi.mocked(ApiClient.prototype.saveDocument).mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    await render(documentModel("R1", "before"));

    await dispatchInput(textarea(), "saved");
    actions!.save();
    await dispatchComposition(textarea(), "compositionstart", "saved");
    await dispatchComposition(textarea(), "compositionupdate", "saved đang gõ");
    await act(async () => { resolveSave({ storageRevision: "R2", model: documentModel("R2", "saved") }); await Promise.resolve(); });
    expect(textarea().value).toBe("saved đang gõ");

    await dispatchInput(textarea(), "saved đang gõ tiếp");
    expect(textarea().value).toBe("saved đang gõ tiếp");
    expect(actions?.canSave).toBe(true);
  });

  it("continues accepting input across repeated save/rebase cycles", async () => {
    vi.mocked(ApiClient.prototype.saveDocument)
      .mockResolvedValueOnce({ storageRevision: "R2", model: documentModel("R2", "first") })
      .mockResolvedValueOnce({ storageRevision: "R3", model: documentModel("R3", "second") });
    await render(documentModel("R1", "before"));

    await dispatchInput(textarea(), "first");
    await save();
    await dispatchInput(textarea(), "second");
    await save();
    await dispatchInput(textarea(), "third");

    expect(textarea().value).toBe("third");
    expect(actions?.canSave).toBe(true);
  });
});
