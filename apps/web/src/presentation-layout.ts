export const EMU_PER_INCH = 914400;
export const CSS_PIXELS_PER_INCH = 96;
export const DEFAULT_COORDINATE_SCALE = CSS_PIXELS_PER_INCH / EMU_PER_INCH;

export interface SlideViewport {
  width: number;
  height: number;
  slideWidth: number;
  slideHeight: number;
  padding?: number;
  zoom?: number;
}

/** Fit logical slide units into the available CSS pixel viewport. */
export function fitSlideScale({
  width,
  height,
  slideWidth,
  slideHeight,
  padding = 56,
  zoom = 1,
}: SlideViewport): number {
  if (width <= 0 || height <= 0 || slideWidth <= 0 || slideHeight <= 0) return DEFAULT_COORDINATE_SCALE * zoom;
  const availableWidth = Math.max(1, width - padding);
  const availableHeight = Math.max(1, height - padding);
  return Math.min(availableWidth / slideWidth, availableHeight / slideHeight) * zoom;
}

export function logicalToPixels(value: number, scale: number): number {
  return value * scale;
}

/** Font sizes in the model are points; scale them with the rendered slide size. */
export function slideFontScale(coordinateScale: number): number {
  return coordinateScale / DEFAULT_COORDINATE_SCALE;
}
