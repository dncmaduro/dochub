import { describe, expect, it } from 'vitest';
import { fileExtension, officeDocumentType } from './editor.types.js';

describe('ONLYOFFICE document mapping', () => {
  it.each([
    ['DOC', 'word'],
    ['docx', 'word'],
    ['XLS', 'cell'],
    ['xlsx', 'cell'],
    ['PPT', 'slide'],
    ['pptx', 'slide'],
  ])('maps %s to %s', (extension, type) => {
    expect(officeDocumentType(extension)).toBe(type);
  });

  it('normalizes filename extensions and rejects unsupported types', () => {
    expect(fileExtension('Report.DOCX', null)).toBe('docx');
    expect(fileExtension('ignored.pdf', '.XLSX')).toBe('xlsx');
    expect(officeDocumentType('pdf')).toBeUndefined();
  });
});
