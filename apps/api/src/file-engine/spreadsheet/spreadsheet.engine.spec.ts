import { zipSync } from 'fflate';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { SpreadsheetEngine } from '../engines/spreadsheet.engine.js';
import { affiliateOrdersFixture } from './affiliate-orders.fixture.js';
import { parseCsv } from './csv-parser.js';
import { parseSpreadsheetPatchRequest } from './spreadsheet-edit.types.js';
import { XlsxPackageReader } from './xlsx-package-reader.js';
import { XlsxParser } from './xlsx-parser.js';
import { XlsxPatcher } from './xlsx-patcher.js';

const workbookXml = `<?xml version="1.0"?><workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:r="urn:schemas-openxmlformats-org:officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/></sheets><definedNames><definedName name="DataCell">Data!$A$1</definedName></definedNames></workbook>`;
const relsXml = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/><Relationship Id="rId2" Target="worksheets/sheet2.xml" Type="worksheet"/></Relationships>`;
const stylesXml = `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="1"><font><b/><sz val="12"/><color rgb="FF112233"/></font></fonts><fills count="1"><fill><patternFill patternType="solid"><fgColor rgb="FFFFEEAA"/></patternFill></fill></fills><borders count="1"><border><left style="thin"/></border></borders><cellXfs count="1"><xf numFmtId="164" fontId="0" fillId="0" borderId="0"><alignment horizontal="center"/></xf></cellXfs></styleSheet>`;
const sharedStringsXml = `<sst count="1" uniqueCount="1"><si><t>Shared Vietnamese</t></si></sst>`;
const sheetXml = `<worksheet><dimension ref="A1:B2"/><sheetViews><sheetView><pane xSplit="1" ySplit="1" state="frozen"/></sheetView></sheetViews><sheetData><row r="1" ht="18"><c r="A1" t="s" s="0"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1" t="b"><v>1</v></c><c r="D1"><f>SUM(B1:B2)</f><v>45</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve"> inline </t></is></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><drawing r:id="rIdDrawing"/><tableParts count="1"><tablePart r:id="rIdTable"/></tableParts></worksheet>`;
function fixture(): Buffer {
  return Buffer.from(zipSync({
    '[Content_Types].xml': new TextEncoder().encode('<Types/>'),
    'xl/workbook.xml': new TextEncoder().encode(workbookXml),
    'xl/_rels/workbook.xml.rels': new TextEncoder().encode(relsXml),
    'xl/styles.xml': new TextEncoder().encode(stylesXml),
    'xl/sharedStrings.xml': new TextEncoder().encode(sharedStringsXml),
    'xl/worksheets/sheet1.xml': new TextEncoder().encode(sheetXml),
    'xl/worksheets/sheet2.xml': new TextEncoder().encode('<worksheet><sheetData><row r="1"><c r="A1"><v>99</v></c></row></sheetData></worksheet>'),
    'xl/drawings/drawing1.xml': new TextEncoder().encode('<drawing preserved="yes"/>'),
    'xl/tables/table1.xml': new TextEncoder().encode('<table displayName="Table1"/>'),
  }));
}
function descriptor(name: string, mimeType: string) {
  return { fileId: 'file', nodeId: 'node', name, mimeType, extension: null, size: 10, storageRef: { provider: 'GOOGLE_DRIVE' as const, objectId: 'drive' } };
}

describe('SpreadsheetEngine', () => {
  it('opens a production-shaped affiliate workbook through the native engine', async () => {
    const source = affiliateOrdersFixture();
    const storage = {
      openRead: vi.fn().mockImplementation(async () => ({
        stream: Readable.from([source]),
        metadata: { revision: 'affiliate-r1', sizeBytes: BigInt(source.byteLength), mimeType: 'application/octet-stream' },
        range: null,
      })),
    };
    const file = descriptor('affiliate_orders_7695543313789257492.xlsx', 'application/octet-stream');
    const engine = new SpreadsheetEngine();

    await expect(engine.openPreview(file)).resolves.toMatchObject({ kind: 'spreadsheet' });
    const workbook = await engine.openModel(file, { storage: storage as never, storageRevision: 'affiliate-r1' });
    expect(workbook).toMatchObject({
      id: 'xlsx-workbook',
      activeSheetId: expect.stringContaining('s-'),
      sheets: [
        { name: 'Affiliate Orders', rowCount: 1000000, columnCount: 6 },
        { name: 'Summary', rowCount: 3, columnCount: 2 },
      ],
    });
    const sheet = await engine.openSheet(file, workbook.sheets[0]!.id, { storage: storage as never, storageRevision: 'affiliate-r1' });
    expect(sheet).toMatchObject({ frozenPane: { row: 1, column: 1 } });
    expect(sheet.cells).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: 'A2', value: 'AO-1001', valueType: 'string' }),
      expect.objectContaining({ address: 'C2', value: '2026-01-15T00:00:00Z', valueType: 'datetime' }),
      expect.objectContaining({ address: 'E5', value: 'read-only fallback', valueType: 'string' }),
      expect.objectContaining({ address: 'F1000000', valueType: 'formula', editable: false }),
    ]));
  });

  it('normalizes package-root and owner-relative relationship targets safely', () => {
    const source = affiliateOrdersFixture();
    const reader = XlsxPackageReader.fromBytes(source);
    expect(reader.resolveTarget('xl/workbook.xml', '/xl/worksheets/orders.xml')).toBe('xl/worksheets/orders.xml');
    expect(reader.resolveTarget('xl/worksheets/orders.xml', '../tables/orders.xml')).toBe('xl/tables/orders.xml');
    expect(reader.resolveTarget('xl/worksheets/orders.xml', '../../../outside.xml')).toBeNull();
  });

  it('parses a sparse workbook manifest and common cell types', () => {
    const reader = XlsxPackageReader.fromBytes(fixture());
    const parser = new XlsxParser(reader);
    const workbook = parser.workbook('7');
    expect(workbook.sheets.map((sheet) => [sheet.name, sheet.hidden])).toEqual([['Data', undefined], ['Hidden', true]]);
    const sheet = parser.sheet(workbook.activeSheetId);
    expect(sheet.cells.map((cell) => [cell.address, cell.valueType, cell.displayValue])).toEqual([
      ['A1', 'string', 'Shared Vietnamese'], ['B1', 'number', '42'], ['C1', 'boolean', 'TRUE'], ['D1', 'formula', '45'], ['A2', 'string', ' inline '],
    ]);
    expect(sheet.cells.find((cell) => cell.address === 'D1')).toMatchObject({ editable: false, formula: 'SUM(B1:B2)', cachedValue: 45 });
    expect(sheet.cells.find((cell) => cell.address === 'A1')).toMatchObject({ style: { bold: true, fontSize: 12, textColor: '#112233', fillColor: '#FFEEAA', horizontalAlign: 'center', numberFormat: 'yyyy-mm-dd' } });
    expect(sheet.cells.find((cell) => cell.address === 'B1')).toMatchObject({ editable: false, readonlyReason: 'Only the top-left cell of a merged range can be edited.' });
    expect(sheet.frozenPane).toEqual({ row: 1, column: 1 });
  });

  it('patches scalar cells while preserving package parts and formulas', () => {
    const source = fixture();
    const request = parseSpreadsheetPatchRequest({ expectedRevision: '7', edits: [
      { sheetId: 's-MDpySWQx', cell: 'A1', value: 'Edited' },
    ] });
    const reader = XlsxPackageReader.fromBytes(source);
    const parser = new XlsxParser(reader);
    const sheetId = parser.workbook().activeSheetId;
    const actualRequest = { ...request, edits: [{ ...request.edits[0], sheetId, cell: 'A2', value: 'Đã sửa' as const }, { sheetId, cell: 'C2', value: 123 }] };
    const patched = XlsxPatcher.apply(source, actualRequest).bytes;
    const saved = XlsxPackageReader.fromBytes(patched);
    expect(new TextDecoder().decode(saved.entry('xl/drawings/drawing1.xml')!.bytes)).toBe('<drawing preserved="yes"/>');
    expect(new TextDecoder().decode(saved.entry('xl/tables/table1.xml')!.bytes)).toBe('<table displayName="Table1"/>');
    expect(new TextDecoder().decode(saved.entry('xl/sharedStrings.xml')!.bytes)).toBe(sharedStringsXml);
    const model = new XlsxParser(saved).sheet(sheetId);
    expect(model.cells.find((cell) => cell.address === 'A2')).toMatchObject({ value: 'Đã sửa', valueType: 'string' });
    expect(model.cells.find((cell) => cell.address === 'C2')).toMatchObject({ value: 123, valueType: 'number' });
    expect(model.cells.find((cell) => cell.address === 'D1')).toMatchObject({ formula: 'SUM(B1:B2)', editable: false });
  });

  it('rejects formula and merged ghost edits', () => {
    const parser = new XlsxParser(XlsxPackageReader.fromBytes(fixture()));
    const sheetId = parser.workbook().activeSheetId;
    expect(() => XlsxPatcher.apply(fixture(), { expectedRevision: '7', edits: [{ sheetId, cell: 'D1', value: 9 }] })).toThrow('Formula cells are read-only');
    expect(() => XlsxPatcher.apply(fixture(), { expectedRevision: '7', edits: [{ sheetId, cell: 'B1', value: 'no' }] })).toThrow('Merged ghost cells are read-only');
  });

  it('parses and serializes quoted UTF-8 CSV without splitting embedded newlines', () => {
    const csv = parseCsv(new TextEncoder().encode('Tên,Note\r\n"Nguyễn, An","dòng 1\ndòng 2"\r\n'));
    expect(csv.rows).toEqual([['Tên', 'Note'], ['Nguyễn, An', 'dòng 1\ndòng 2']]);
    const engine = new (SpreadsheetEngine as typeof SpreadsheetEngine)();
    expect(engine.capabilities(descriptor('data.csv', 'text/csv')).edit).toBe(true);
    expect(csv.dialect.lineEnding).toBe('\r\n');
  });

  it('uses native preview only for XLSX and CSV, leaving XLS read-only', async () => {
    const engine = new SpreadsheetEngine();
    await expect(engine.openPreview(descriptor('data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))).resolves.toMatchObject({ kind: 'spreadsheet' });
    await expect(engine.openPreview(descriptor('data.csv', 'text/csv'))).resolves.toMatchObject({ kind: 'spreadsheet' });
    await expect(engine.openPreview(descriptor('data.xls', 'application/vnd.ms-excel'))).resolves.toMatchObject({ kind: 'pdf' });
  });

  it('saves through StorageProvider and reopens the authoritative XLSX model', async () => {
    const source = fixture(); let current = source;
    const reader = XlsxPackageReader.fromBytes(source); const sheetId = new XlsxParser(reader).workbook().activeSheetId;
    const storage = {
      stat: vi.fn().mockResolvedValue({ revision: 'r1', sizeBytes: BigInt(source.byteLength) }),
      openRead: vi.fn().mockImplementation(async () => ({ stream: Readable.from([current]), metadata: { revision: 'r1', sizeBytes: BigInt(current.byteLength), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, range: null })),
      replace: vi.fn().mockImplementation(async (_ref: unknown, input: { stream: Readable }) => { const chunks: Buffer[] = []; for await (const chunk of input.stream) chunks.push(Buffer.from(chunk)); current = Buffer.concat(chunks); return { metadata: { revision: 'r2', sizeBytes: BigInt(current.byteLength), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, ref: { provider: 'GOOGLE_DRIVE', objectId: 'drive' } }; }),
    };
    const result = await new SpreadsheetEngine().save(descriptor('data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), { expectedRevision: 'r1', edits: [{ sheetId, cell: 'A2', value: 'saved' }] }, { storage: storage as never, expectedRevision: 'r1' });
    expect(result.storageRevision).toBe('r2');
    expect(result.model.storageRevision).toBe('r2');
    expect(storage.replace).toHaveBeenCalledOnce();
    expect(new XlsxParser(XlsxPackageReader.fromBytes(current)).sheet(sheetId).cells.find((cell) => cell.address === 'A2')?.value).toBe('saved');
  });
});
