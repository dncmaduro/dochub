import { useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { PresentationElement, PresentationParagraph, PresentationSlideModel, PresentationTextElement } from "./api";
import { logicalToPixels, slideFontScale } from "./presentation-layout";

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol.toLowerCase()) ? url.toString() : null;
  } catch { return null; }
}

function elementStyle(element: PresentationElement, scale: number): CSSProperties {
  return {
    position: "absolute",
    left: logicalToPixels(element.x, scale),
    top: logicalToPixels(element.y, scale),
    width: logicalToPixels(element.width, scale),
    height: logicalToPixels(element.height, scale),
    zIndex: element.zIndex + 1,
    transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined,
    transformOrigin: "center center",
  };
}

function paragraphContent(paragraph: PresentationParagraph, key: string, fontScale: number): ReactNode {
  const text = paragraph.runs.map((run) => {
    const style: CSSProperties = { fontWeight: run.bold ? 700 : undefined, fontStyle: run.italic ? "italic" : undefined, textDecoration: run.underline ? "underline" : undefined, fontFamily: run.fontFamily ?? undefined, fontSize: run.fontSize ? `${run.fontSize * 96 / 72 * fontScale}px` : undefined, color: run.color ?? undefined, whiteSpace: "pre-wrap" };
    const content = <span key={run.id} style={style}>{run.text}</span>;
    const href = run.link ? safeHref(run.link.href) : null;
    return href ? <a key={`${run.id}-link`} href={href} target="_blank" rel="noopener noreferrer">{content}</a> : content;
  });
  const prefix = paragraph.bullet ? `${paragraph.bullet.kind === "number" ? "1." : "•"} ` : "";
  return <div key={key} className="presentation-paragraph" style={{ textAlign: paragraph.alignment === "justified" ? "justify" : paragraph.alignment, paddingLeft: paragraph.bullet ? `${Math.min(8, paragraph.bullet.level) * 14}px` : undefined }}>{prefix}{text}</div>;
}

function textContent(element: PresentationTextElement, fontScale: number) {
  return <div className="presentation-text-content" style={{ fontSize: `${16 * fontScale}px` }}>{element.paragraphs.map((paragraph, index) => paragraphContent(paragraph, `${element.id}-p-${index}`, fontScale))}</div>;
}

function shapeContent(element: Extract<PresentationElement, { type: "shape" | "text" }>, fontScale: number) {
  const radius = element.shapeType.toLowerCase().includes("round") ? "14%" : element.shapeType.toLowerCase() === "ellipse" || element.shapeType.toLowerCase() === "oval" ? "50%" : undefined;
  return <div className="presentation-shape-content" style={{ borderRadius: radius, background: element.fillColor ?? "transparent", border: element.borderColor ? `${Math.max(0.5, (element.borderWidth ?? 1) * fontScale)}px solid ${element.borderColor}` : undefined }} />;
}

function assetUrl(src: string | undefined, modelUrl: string): string | undefined {
  if (!src) return undefined;
  try { return new URL(src, modelUrl).toString(); } catch { return undefined; }
}

function elementContent(element: PresentationElement, modelUrl: string, fontScale: number): ReactNode {
  if (element.type === "text") return <>{shapeContent(element, fontScale)}{textContent(element, fontScale)}</>;
  if (element.type === "image") return <img className="presentation-image" src={assetUrl(element.src, modelUrl)} alt="" draggable={false} />;
  if (element.type === "shape") return shapeContent(element, fontScale);
  if (element.type === "group") return <>{element.children.map((child) => elementContent(child, modelUrl, fontScale))}</>;
  return <div className="presentation-unsupported" role="note" style={{ fontSize: `${11 * fontScale}px` }}><strong>{element.label}</strong><span>Preserved, not editable</span></div>;
}

export function SlideCanvas({ slide, modelUrl, scale, mode, selectedElementId, onSelect, onMove, onResize }: { slide: PresentationSlideModel; modelUrl: string; scale: number; mode: "view" | "edit"; selectedElementId: string | null; onSelect: (elementId: string | null) => void; onMove: (elementId: string, x: number, y: number) => void; onResize: (elementId: string, width: number, height: number) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ element: PresentationElement; startX: number; startY: number; x: number; y: number; width: number; height: number; resize: boolean } | null>(null);
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>, element: PresentationElement, resize = false) => {
    if (mode !== "edit" || (resize ? !element.editable.resize : !element.editable.move)) return;
    event.stopPropagation();
    onSelect(element.id);
    drag.current = { element, startX: event.clientX, startY: event.clientY, x: element.x, y: element.y, width: element.width, height: element.height, resize };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const rect = root.current?.getBoundingClientRect();
    if (!rect) { drag.current = null; return; }
    const dx = (event.clientX - current.startX) * slide.width / rect.width;
    const dy = (event.clientY - current.startY) * slide.height / rect.height;
    if (current.resize) {
      const ratio = current.element.type === "image" && current.height > 0 ? current.width / current.height : null;
      const width = Math.max(1, current.width + dx);
      onResize(current.element.id, width, ratio ? width / ratio : Math.max(1, current.height + dy));
    } else onMove(current.element.id, current.x + dx, current.y + dy);
    drag.current = null;
  };
  const render = (element: PresentationElement): ReactNode => {
    const selected = mode === "edit" && element.id === selectedElementId;
    const style = elementStyle(element, scale);
    const isGroup = element.type === "group";
    return <div key={element.id} className={`presentation-element presentation-element-${element.type}${selected ? " is-selected" : ""}`} style={style} onPointerDown={(event) => pointerDown(event, element)} onClick={(event) => { event.stopPropagation(); onSelect(element.id); }}>
      {isGroup ? null : elementContent(element, modelUrl, slideFontScale(scale))}
      {selected && element.editable.resize && <div className="presentation-resize-handle" role="button" aria-label="Resize element" onPointerDown={(event) => pointerDown(event, element, true)} onPointerUp={pointerUp} />}
      {selected && <span className="presentation-selection-label">{element.type}</span>}
    </div>;
  };
  const renderable = slide.elements.flatMap((element) => element.type === "group" ? element.children : [element]);
  return <div ref={root} className="presentation-slide-canvas" style={{ width: logicalToPixels(slide.width, scale), height: logicalToPixels(slide.height, scale), background: slide.background ?? "#fff" }} onPointerMove={() => undefined} onPointerUp={pointerUp} onClick={() => onSelect(null)}>{renderable.slice().sort((a, b) => a.zIndex - b.zIndex).map(render)}</div>;
}
