import { createElement, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { ApiClient, type DocumentBlock, type DocumentInline, type DocumentModel, type DocumentTableCell, type DocumentTextRun } from "./api";
import { DocumentEditor } from "./DocumentEditor";
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

function assetUrl(src: string | undefined, modelUrl: string): string | undefined {
  if (!src) return undefined;
  try {
    return new URL(src, modelUrl).toString();
  } catch {
    return undefined;
  }
}

function inlineStyle(run: DocumentTextRun): CSSProperties {
  return {
    fontWeight: run.bold ? 700 : undefined,
    fontStyle: run.italic ? "italic" : undefined,
    textDecoration: [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
    fontSize: run.fontSize ? `${run.fontSize}pt` : undefined,
    fontFamily: run.fontFamily ?? undefined,
    color: run.color ?? undefined,
    verticalAlign: run.verticalAlign === "superscript" ? "super" : run.verticalAlign === "subscript" ? "sub" : undefined,
  };
}

function InlineContent({ content, modelUrl }: { content: DocumentInline[]; modelUrl: string }) {
  return <>{content.map((inline) => inline.kind === "text" ? (() => {
    const href = inline.link ? safeHref(inline.link.href) : null;
    const text = <span key={inline.id} style={inlineStyle(inline)}>{inline.text}</span>;
    return href ? <a key={`${inline.id}-link`} href={href} target="_blank" rel="noopener noreferrer">{text}</a> : text;
  })() : <img key={inline.id} className="document-inline-image" src={assetUrl(inline.src, modelUrl)} alt={inline.altText ?? ""} width={inline.widthPx ?? undefined} height={inline.heightPx ?? undefined} />)}</>;
}

function paragraphStyle(block: { alignment: string; spacingBeforePt: number; spacingAfterPt: number; lineSpacing: number | null; indentLeftPt: number; indentRightPt: number; firstLineIndentPt: number }): CSSProperties {
  return {
    textAlign: block.alignment as CSSProperties["textAlign"],
    marginTop: `${block.spacingBeforePt}pt`,
    marginBottom: `${block.spacingAfterPt}pt`,
    lineHeight: block.lineSpacing ?? undefined,
    marginLeft: `${block.indentLeftPt}pt`,
    marginRight: `${block.indentRightPt}pt`,
    textIndent: `${block.firstLineIndentPt}pt`,
  };
}

function ListBlocks({ blocks, modelUrl }: { blocks: Array<Extract<DocumentBlock, { type: "list-item" }>>; modelUrl: string }) {
  const counters: number[] = [];
  return <div className="document-list" role="list">
    {blocks.map((block) => {
      counters[block.level] = (counters[block.level] ?? 0) + 1;
      counters.length = block.level + 1;
      const marker = block.ordered ? `${counters[block.level]}.` : block.marker?.replace(/%\d+\./g, "•") || "•";
      return <div key={block.id} className="document-list-item" role="listitem" style={{ ...paragraphStyle(block), paddingLeft: `${block.level * 24 + 24}px` }}>
        <span className="document-list-marker" aria-hidden="true">{marker}</span>
        <span><InlineContent content={block.content} modelUrl={modelUrl} /></span>
      </div>;
    })}
  </div>;
}

function TableCellRenderer({ cell, modelUrl }: { cell: DocumentTableCell; modelUrl: string }) {
  const borders = Object.entries(cell.borders).reduce<Record<string, string>>((styles, [side, border]) => {
    const borderStyle = border.style === "double" ? "double" : border.style === "dashed" ? "dashed" : border.style === "dotted" ? "dotted" : "solid";
    if (border.color && border.widthPt) styles[`border${side[0].toUpperCase()}${side.slice(1)}`] = `${border.widthPt}pt ${borderStyle} ${border.color}`;
    return styles;
  }, {});
  return <td style={{ width: cell.widthPx ?? undefined, backgroundColor: cell.backgroundColor ?? undefined, ...borders }}>
    <BlockList blocks={cell.blocks} modelUrl={modelUrl} />
  </td>;
}

function BlockList({ blocks, modelUrl }: { blocks: DocumentBlock[]; modelUrl: string }) {
  const output: ReactNode[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === "list-item") {
      const list: Array<Extract<DocumentBlock, { type: "list-item" }>> = [];
      while (blocks[index]?.type === "list-item") list.push(blocks[index++] as Extract<DocumentBlock, { type: "list-item" }>);
      output.push(<ListBlocks key={list[0].id} blocks={list} modelUrl={modelUrl} />);
      index -= 1;
      continue;
    }
    if (block.type === "paragraph" || block.type === "heading") {
      const props = { key: block.id, className: block.type === "heading" ? "document-heading" : "document-paragraph", style: paragraphStyle(block) };
      output.push(block.type === "heading"
        ? createElement(`h${Math.min(6, block.level)}`, props, <InlineContent content={block.content} modelUrl={modelUrl} />)
        : <p {...props}><InlineContent content={block.content} modelUrl={modelUrl} /></p>);
    } else if (block.type === "table") {
      output.push(<table key={block.id} className="document-table"><tbody>{block.rows.map((row) => <tr key={row.id}>{row.cells.map((cell) => <TableCellRenderer key={cell.id} cell={cell} modelUrl={modelUrl} />)}</tr>)}</tbody></table>);
    } else if (block.type === "image") {
      output.push(<figure key={block.id} className="document-image-block"><img src={assetUrl(block.src, modelUrl)} alt={block.altText ?? ""} width={block.widthPx ?? undefined} height={block.heightPx ?? undefined} /></figure>);
    } else {
      output.push(<div key={block.id} className="document-unsupported" role="note">{block.label} omitted</div>);
    }
  }
  return <>{output}</>;
}

export function DocumentViewer({ modelUrl, nodeId, mode, onModeChange, onRegisterActions, attempt, onReady, onError, onDirtyChange }: { modelUrl: string; nodeId: string; mode: WorkspaceMode; onModeChange: (mode: WorkspaceMode) => void; onRegisterActions: RegisterWorkspaceActions; attempt: number; onReady: () => void; onError: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [model, setModel] = useState<DocumentModel | null>(null);
  useEffect(() => {
    let active = true;
    void api.getDocumentModel(modelUrl).then((next) => {
      if (!active) return;
      setModel(next);
      onDirtyChange(false);
      onReady();
    }).catch(() => {
      if (active) onError();
    });
    return () => { active = false; };
  }, [modelUrl, attempt, onDirtyChange, onReady, onError]);
  const surface = useMemo(() => (current: DocumentModel) => <article className="document-surface"><BlockList blocks={current.blocks} modelUrl={modelUrl} /></article>, [modelUrl]);
  return <div className="document-viewer" aria-busy={!model}>{model ? <DocumentEditor nodeId={nodeId} modelUrl={modelUrl} initialModel={model} mode={mode} onModeChange={onModeChange} onRegisterActions={onRegisterActions} onDirtyChange={onDirtyChange} view={surface} /> : <div className="document-loading" role="status">Loading document…</div>}</div>;
}
