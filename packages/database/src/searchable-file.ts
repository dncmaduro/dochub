/** Trusted MIME types whose stored binary is eligible for Apache Tika extraction. */
const SEARCHABLE_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export function isSearchableFileMimeType(mimeType: string): boolean {
  return SEARCHABLE_MIME_TYPES.has(mimeType.toLowerCase());
}

export const searchableFileMimeTypes = [...SEARCHABLE_MIME_TYPES];
