import { useLayoutEffect, useRef, useState } from "react";
import type { PresentationSlideDescriptor, PresentationSlideModel } from "./api";
import { SlideCanvas } from "./SlideCanvas";

export function SlideThumbnailRail({ descriptors, slides, modelUrl, activeSlideId, thumbnailErrors, onLoad, onSelect }: { descriptors: PresentationSlideDescriptor[]; slides: Record<string, PresentationSlideModel>; modelUrl: string; activeSlideId: string; thumbnailErrors: Record<string, string>; onLoad: (slideId: string) => void; onSelect: (slideId: string) => void }) {
  const rail = useRef<HTMLElement>(null);
  const [thumbnailWidth, setThumbnailWidth] = useState(72);
  useLayoutEffect(() => {
    const node = rail.current;
    if (!node) return undefined;
    const measure = () => setThumbnailWidth(Math.max(24, node.clientWidth - 59));
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = rail.current;
    if (!node) return undefined;
    const items = [...node.querySelectorAll<HTMLElement>("[data-slide-id]")];
    const request = (item: Element) => onLoad(item.getAttribute("data-slide-id") ?? "");
    if (typeof IntersectionObserver === "undefined") {
      items.slice(0, 4).forEach(request);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => entries.filter((entry) => entry.isIntersecting).forEach((entry) => request(entry.target)), { root: node, rootMargin: "120px" });
    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, [descriptors, onLoad]);
  return <aside ref={rail} className="presentation-thumbnail-rail" aria-label="Slides">{descriptors.map((descriptor) => {
    const slide = slides[descriptor.id];
    return <button data-slide-id={descriptor.id} key={descriptor.id} type="button" className={`presentation-thumbnail${descriptor.id === activeSlideId ? " is-active" : ""}`} onClick={() => thumbnailErrors[descriptor.id] ? onLoad(descriptor.id) : onSelect(descriptor.id)} aria-label={`Slide ${descriptor.index + 1}`}><span>{descriptor.index + 1}</span><div className="presentation-thumbnail-canvas" style={{ aspectRatio: `${descriptor.width} / ${descriptor.height}` }}>{thumbnailErrors[descriptor.id] ? <div className="presentation-thumbnail-empty presentation-thumbnail-error">Retry</div> : slide ? <SlideCanvas modelUrl={modelUrl} slide={slide} scale={thumbnailWidth / Math.max(1, slide.width)} mode="view" selectedElementId={null} onSelect={() => undefined} onMove={() => undefined} onResize={() => undefined} /> : <div className="presentation-thumbnail-empty">Loading…</div>}</div>{descriptor.hidden && <small>Hidden</small>}</button>;
  })}</aside>;
}
