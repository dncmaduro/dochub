import { SpreadsheetPackageError } from './xlsx-package-reader.js';
import { SPREADSHEET_LIMITS } from './spreadsheet-limits.js';
import type { CellModel, SheetModel } from './workbook-model.js';
import { cellAddress } from './xlsx-parser.js';

export interface CsvDialect { delimiter: string; lineEnding: '\n' | '\r\n' | '\r'; bom: boolean; trailingNewline: boolean; }
export interface CsvDocument { rows: string[][]; dialect: CsvDialect; sheet: SheetModel; }
function detectDelimiter(sample: string): string {
  const candidates = [',', '\t', ';'];
  return candidates.map((delimiter) => ({ delimiter, count: sample.split(delimiter).length - 1 })).sort((left, right) => right.count - left.count)[0]?.delimiter ?? ',';
}
function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"' && field === '') { quoted = true; continue; }
    if (char === delimiter) { row.push(field); field = ''; continue; }
    if (char === '\n' || char === '\r') {
      row.push(field); field = ''; rows.push(row); row = [];
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      continue;
    }
    field += char;
  }
  if (quoted) throw new SpreadsheetPackageError('CSV contains an unterminated quoted field');
  if (field.length || row.length || text.endsWith(delimiter)) { row.push(field); rows.push(row); }
  return rows;
}
export function parseCsv(bytes: Uint8Array): CsvDocument {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(bom ? 3 : 0)); }
  catch { throw new SpreadsheetPackageError('CSV must be valid UTF-8'); }
  if (bytes.byteLength > SPREADSHEET_LIMITS.compressedBytes) throw new SpreadsheetPackageError('CSV source exceeds the package limit', 'resource-limit');
  const lineEnding: CsvDialect['lineEnding'] = text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n';
  const delimiter = detectDelimiter(text.slice(0, 32_000)); const rows = parseRows(text, delimiter);
  if (rows.length > SPREADSHEET_LIMITS.maxCsvRows) throw new SpreadsheetPackageError('CSV contains too many rows', 'resource-limit');
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 1);
  if (columnCount > SPREADSHEET_LIMITS.maxCsvColumns || rows.length * columnCount > SPREADSHEET_LIMITS.maxCsvCells) throw new SpreadsheetPackageError('CSV contains too many cells', 'resource-limit');
  const cells: CellModel[] = [];
  rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (value === '') return;
    const address = cellAddress(rowIndex + 1, columnIndex + 1);
    cells.push({ address, row: rowIndex + 1, column: columnIndex + 1, value, valueType: 'string', displayValue: value, editable: true });
  }));
  const sheet: SheetModel = { version: 1, id: 'csv-sheet-1', name: 'Sheet1', dimensions: { rowCount: Math.max(1, rows.length), columnCount: Math.max(1, columnCount) }, cells, rowMetadata: {}, columnMetadata: {}, mergedRanges: [] };
  return { rows, dialect: { delimiter, lineEnding, bom, trailingNewline: text.endsWith(lineEnding) }, sheet };
}
