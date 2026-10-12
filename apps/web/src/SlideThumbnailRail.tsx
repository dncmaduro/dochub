import type { PresentationSlideDescriptor, PresentationSlideModel } from "./api";
import { SlideCanvas } from "./SlideCanvas";

export function SlideThumbnailRail({ descriptors, slides, modelUrl, activeSlideId, onSelect }: { descriptors: PresentationSlideDescriptor[]; slides: Record<string, PresentationSlideModel>; modelUrl: string; activeSlideId: string; onSelect: (slideId: string) => void }) {
  return <aside className="presentation-thumbnail-rail" aria-label="Slides">{descriptors.map((descriptor) => <button key={descriptor.id} type="button" className={`presentation-thumbnail${descriptor.id === activeSlideId ? " is-active" : ""}`} onClick={() => onSelect(descriptor.id)} aria-label={`Slide ${descriptor.index + 1}`}><span>{descriptor.index + 1}</span><div className="presentation-thumbnail-canvas">{slides[descriptor.id] ? <SlideCanvas modelUrl={modelUrl} slide={slides[descriptor.id]} mode="view" selectedElementId={null} onSelect={() => undefined} onMove={() => undefined} onResize={() => undefined} /> : <div className="presentation-thumbnail-empty">Loading…</div>}</div>{descriptor.hidden && <small>Hidden</small>}</button>)}</aside>;
}
