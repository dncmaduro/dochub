export const PRESENTATION_LIMITS = {
  compressedBytes: 75 * 1024 * 1024,
  decompressedBytes: 250 * 1024 * 1024,
  entryBytes: 40 * 1024 * 1024,
  xmlEntryBytes: 15 * 1024 * 1024,
  maxEntries: 4_000,
  maxSlides: 500,
  maxElementsPerSlide: 2_000,
  maxTextRunsPerSlide: 10_000,
  maxMediaEntries: 1_000,
  maxMediaEntryBytes: 25 * 1024 * 1024,
  maxPatchElements: 500,
  maxTextLengthPerElement: 200_000,
} as const;
