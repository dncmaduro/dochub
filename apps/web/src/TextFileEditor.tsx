import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiClient, ApiError, type TextFileFormat, type TextFileModel } from "./api";
import type { RegisterWorkspaceActions, WorkspaceMode } from "./workspace";

const api = new ApiClient();

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol.toLowerCase()) ? url.toString() : null;
  } catch {
    return null;
  }
}

function inlineMarkdown(value: string, keyPrefix: string): ReactNode[] {
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*]+)\*|_([^_]+)_/gu;
  const result: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) result.push(value.slice(cursor, match.index));
    const linkText = match[1];
    const href = match[2] ? safeHref(match[2]) : null;
    if (linkText) result.push(href ? <a key={`${keyPrefix}-${key++}`} href={href} target="_blank" rel="noopener noreferrer">{linkText}</a> : linkText);
    else if (match[3] || match[4]) result.push(<strong key={`${keyPrefix}-${key++}`}>{match[3] ?? match[4]}</strong>);
    else if (match[5]) result.push(<code key={`${keyPrefix}-${key++}`}>{match[5]}</code>);
    else if (match[6]) result.push(<em key={`${keyPrefix}-${key++}`}>{match[6]}</em>);
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) result.push(value.slice(cursor));
  return result;
}

function MarkdownPreview({ source }: { source: string }) {
  const lines = source.replace(/\r\n/gu, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") { index += 1; continue; }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`code-${index}`}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}` as "h1";
      blocks.push(<Tag key={`heading-${index}`}>{inlineMarkdown(heading[2], `heading-${index}`)}</Tag>);
      index += 1;
      continue;
    }
    if (/^\s*>\s?/u.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/u.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/u, ""));
      blocks.push(<blockquote key={`quote-${index}`}>{quote.map((item, itemIndex) => <p key={itemIndex}>{inlineMarkdown(item, `quote-${index}-${itemIndex}`)}</p>)}</blockquote>);
      continue;
    }
    if (/^\s*(?:[-*+] |\d+\. )/u.test(line)) {
      const ordered = /^\s*\d+\. /u.test(line);
      const items: string[] = [];
      while (index < lines.length && /^\s*(?:[-*+] |\d+\. )/u.test(lines[index])) items.push(lines[index++].replace(/^\s*(?:[-*+] |\d+\. )/u, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, `list-${index}-${itemIndex}`)}</li>)}</List>);
      continue;
    }
    if (index + 1 < lines.length && /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/u.test(lines[index + 1])) {
      const cells = (value: string) => value.trim().replace(/^\||\|$/gu, "").split("|").map((cell) => cell.trim());
      const header = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|")) rows.push(cells(lines[index++]));
      blocks.push(<table key={`table-${index}`}><thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{inlineMarkdown(cell, `table-h-${index}-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inlineMarkdown(cell, `table-${index}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table>);
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() !== "" && !/^(?:#{1,6}\s|```|\s*>\s?|\s*(?:[-*+] |\d+\. ))/u.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={`paragraph-${index}`}>{inlineMarkdown(paragraph.join("\n"), `paragraph-${index}`)}</p>);
  }
  return <article className="text-markdown-preview">{blocks}</article>;
}

function structuredPreview(format: TextFileFormat, source: string): { value: string; error: string | null } {
  if (format === "json") {
    try { return { value: JSON.stringify(JSON.parse(source), null, 2) ?? "null", error: null }; }
    catch { return { value: source, error: "JSON is not valid." }; }
  }
  if (format === "xml") {
    try {
      const document = new DOMParser().parseFromString(source, "application/xml");
      if (document.querySelector("parsererror")) return { value: source, error: "XML is not well-formed." };
      return { value: source.replace(/>\s*</gu, ">\n<"), error: null };
    } catch { return { value: source, error: "XML is not well-formed." }; }
  }
  return { value: source, error: null };
}

function formatLabel(format: TextFileFormat): string {
  return format === "text" ? "Plain text" : format === "markdown" ? "Markdown" : format.toUpperCase();
}

export function TextFileEditor({ nodeId, initialModel, canEdit, mode: workspaceMode, onModeChange, onRegisterActions, onDirtyChange, onReload }: { nodeId: string; initialModel: TextFileModel; canEdit: boolean; mode: WorkspaceMode; onModeChange: (mode: WorkspaceMode) => void; onRegisterActions: RegisterWorkspaceActions; onDirtyChange: (dirty: boolean) => void; onReload: () => void }) {
  const [value, setValue] = useState(initialModel.content);
  const [baseline, setBaseline] = useState(initialModel.content);
  const [displayMode, setDisplayMode] = useState<"preview" | "source">(initialModel.parseError || initialModel.format === "text" ? "source" : "preview");
  const [status, setStatus] = useState<"clean" | "dirty" | "saving" | "save-failed" | "conflict">("clean");
  const [error, setError] = useState("");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const composing = useRef(false);
  const dirty = value !== baseline;
  const preview = useMemo(() => structuredPreview(initialModel.format, value), [initialModel.format, value]);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const changeValue = useCallback((next: string) => {
    setValue((current) => {
      if (current === next) return current;
      undoStack.current.push(current);
      if (undoStack.current.length > 100) undoStack.current.shift();
      redoStack.current = [];
      setCanUndo(true);
      setCanRedo(false);
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (previous === undefined) return;
    setValue((current) => { redoStack.current.push(current); return previous; });
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
  }, []);
  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (next === undefined) return;
    setValue((current) => { undoStack.current.push(current); return next; });
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
  }, []);

  const save = useCallback(async () => {
    if (!canEdit || !initialModel.storageRevision || !dirty) return;
    setStatus("saving");
    setError("");
    try {
      const saved = await api.saveText(nodeId, { expectedRevision: initialModel.storageRevision, content: value });
      setBaseline(saved.model.content);
      setValue(saved.model.content);
      undoStack.current = [];
      redoStack.current = [];
      setCanUndo(false);
      setCanRedo(false);
      setStatus("clean");
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 409) {
        setStatus("conflict");
        setError("This file changed after it was opened. Reload to discard local edits.");
      } else {
        setStatus("save-failed");
        setError(requestError instanceof ApiError ? requestError.message : "The text could not be saved.");
      }
    }
  }, [canEdit, dirty, initialModel.storageRevision, nodeId, value]);

  const discardAndView = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setValue(baseline);
    setStatus("clean");
    setError("");
    undoStack.current = [];
    redoStack.current = [];
    setCanUndo(false);
    setCanRedo(false);
    onDirtyChange(false);
    onModeChange("view");
  }, [baseline, dirty, onDirtyChange, onModeChange]);
  useEffect(() => {
    onRegisterActions({ save: () => { void save(); }, view: discardAndView, canEdit: canEdit && Boolean(initialModel.editable), canSave: dirty && status !== "saving", saving: status === "saving" });
  }, [canEdit, discardAndView, dirty, initialModel.editable, onRegisterActions, save, status]);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (composing.current) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (!modifier) return;
    if (event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    else if (event.key.toLowerCase() === "z" && event.shiftKey) { event.preventDefault(); redo(); }
    else if (event.key.toLowerCase() === "z") { event.preventDefault(); undo(); }
  }

  const previewBody = initialModel.format === "markdown"
    ? <MarkdownPreview source={value} />
    : <pre className="text-plain-preview">{preview.value}</pre>;
  const editing = workspaceMode === "edit";
  const sourceEditor = <textarea readOnly={!editing} aria-label={`${formatLabel(initialModel.format)} source`} className="text-source-editor" value={value} onChange={(event) => changeValue(event.target.value)} onKeyDown={onKeyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} spellCheck={initialModel.format === "text" || initialModel.format === "markdown"} />;

  return <div className="text-file-editor">
    <div className="text-file-toolbar">
      <span className="text-file-format">{formatLabel(initialModel.format)}</span>
      <button type="button" className="text-file-tool" onClick={() => setDisplayMode("preview")} disabled={displayMode === "preview"}>{initialModel.format === "markdown" ? "Preview" : "Formatted preview"}</button>
      <button type="button" className="text-file-tool" onClick={() => setDisplayMode("source")} disabled={displayMode === "source"}>Source</button>
      {editing && <>
        <button type="button" className="text-file-tool" onClick={undo} disabled={!canUndo}>Undo</button>
        <button type="button" className="text-file-tool" onClick={redo} disabled={!canRedo}>Redo</button>
      </>}
      <span className="text-file-status" role="status">{status === "saving" ? "Saving…" : status === "conflict" ? "Conflict" : status === "save-failed" ? "Save failed" : dirty ? "Unsaved changes" : "Saved"}</span>
    </div>
    {error && <div className="text-file-error" role="alert"><span>{error}</span>{status === "conflict" && <button type="button" className="text-file-tool" onClick={onReload}>Reload</button>}</div>}
    {preview.error && <div className="text-file-parse-error" role="alert">{preview.error} Source remains available for inspection and editing.</div>}
    <div className="text-file-body">
      {editing ? sourceEditor : displayMode === "source" ? <div className="text-source-view">{sourceEditor}</div> : previewBody}
    </div>
  </div>;
}
