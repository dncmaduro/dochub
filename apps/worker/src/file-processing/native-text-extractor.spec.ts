import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extractNativeText, NativeExtractionError, nativeExtractionSupported } from './native-text-extractor.js';

function office(entries: Record<string, string>) {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([path, value]) => [path, strToU8(value)]))));
}

describe('native text extraction', () => {
  it('extracts semantic DOCX paragraph and table text without OOXML markup', () => {
    const bytes = office({
      'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Báo cáo</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Doanh thu</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    });
    expect(extractNativeText(bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx', 100).text).toBe('Báo cáo Doanh thu');
  });

  it('extracts XLSX shared strings, numeric values, formulas, and sheets', () => {
    const bytes = office({
      'xl/sharedStrings.xml': '<sst><si><t>Khí tài</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><f>SUM(A1:A2)</f><v>42</v></c></row></sheetData></worksheet>',
    });
    const text = extractNativeText(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'report.xlsx', 100).text;
    expect(text).toContain('Khí tài');
    expect(text).toContain('SUM(A1:A2)');
    expect(text).toContain('42');
  });

  it('extracts ordered slide text and robust quoted CSV values', () => {
    const presentation = office({
      'ppt/slides/slide2.xml': '<p:sld><a:t>Second</a:t></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:t>Báo cáo</a:t></p:sld>',
    });
    expect(extractNativeText(presentation, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx', 100).text).toBe('Slide 1: Báo cáo\nSlide 2: Second');
    expect(extractNativeText(Buffer.from('name,note\nLan,"hello, world"'), 'text/csv', 'report.csv', 100).text).toContain('hello, world');
  });

  it('declares supported native formats and records deterministic truncation', () => {
    expect(nativeExtractionSupported('text/plain', 'x.txt')).toBe(true);
    expect(nativeExtractionSupported('image/png', 'x.png')).toBe(false);
    expect(extractNativeText(Buffer.from('abcdef'), 'text/plain', 'x.txt', 3)).toEqual({ text: 'abc', truncated: true });
  });

  it.each([
    ['text/plain', 'notes.txt', 'phrase A'],
    ['text/markdown', 'notes.md', '# phrase A'],
    ['application/json', 'data.json', '{"message":"phrase A"}'],
    ['application/xml', 'data.xml', '<message>phrase A</message>'],
  ])('extracts %s content for revision indexing', (mime, name, source) => {
    expect(nativeExtractionSupported(mime, name)).toBe(true);
    expect(extractNativeText(Buffer.from(source), mime, name, 100).text).toContain('phrase A');
  });

  it('rejects a highly compressed OOXML archive before decompression', () => {
    const bomb = Buffer.from(zipSync({ 'word/document.xml': strToU8('a'.repeat(1024 * 1024)) }, { level: 9 }));
    try {
      extractNativeText(bomb, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'bomb.docx', 100);
      throw new Error('Expected extraction to reject compressed archive');
    } catch (error) {
      expect(error).toBeInstanceOf(NativeExtractionError);
      expect((error as NativeExtractionError).code).toBe('LIMIT_EXCEEDED');
    }
  });
});
