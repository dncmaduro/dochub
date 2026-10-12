import { useState } from "react";

export function ImageViewer({ src, alt, onReady, onError }: { src: string; alt: string; onReady: () => void; onError: () => void }) {
  const [scale, setScale] = useState(1);
  return <div className="image-viewer">
    <div className="image-viewer-toolbar" aria-label="Image controls">
      <button type="button" className="image-viewer-button" onClick={() => setScale((value) => Math.max(0.25, value - 0.25))} aria-label="Zoom out">−</button>
      <span>{Math.round(scale * 100)}%</span>
      <button type="button" className="image-viewer-button" onClick={() => setScale((value) => Math.min(4, value + 0.25))} aria-label="Zoom in">+</button>
      <button type="button" className="image-viewer-button" onClick={() => setScale(1)}>Fit</button>
    </div>
    <div className="image-viewer-viewport">
      <img src={src} alt={alt} onLoad={onReady} onError={onError} style={{ transform: `scale(${scale})` }} />
    </div>
  </div>;
}

