export const OFFICE_DOCUMENT_TYPES = Object.freeze({
  doc: 'word', docx: 'word', xls: 'cell', xlsx: 'cell', ppt: 'slide', pptx: 'slide',
} as const);

export type OfficeExtension = keyof typeof OFFICE_DOCUMENT_TYPES;

export function officeDocumentType(extension: string): (typeof OFFICE_DOCUMENT_TYPES)[OfficeExtension] | undefined {
  return OFFICE_DOCUMENT_TYPES[extension.trim().replace(/^\./, '').toLowerCase() as OfficeExtension];
}

export function fileExtension(filename: string, extension: string | null): string {
  if (extension?.trim()) return extension.trim().replace(/^\./, '').toLowerCase();
  const index = filename.lastIndexOf('.');
  return index === -1 ? '' : filename.slice(index + 1).toLowerCase();
}
