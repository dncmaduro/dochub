import type { CsvDialect } from './csv-parser.js';
import { parseCellAddress } from './xlsx-parser.js';
import type { SpreadsheetCellEdit } from './spreadsheet-edit.types.js';
import { SPREADSHEET_LIMITS } from './spreadsheet-limits.js';
import { SpreadsheetEditValidationError } from './spreadsheet-edit.types.js';
export function serializeCsv(rows: string[][], dialect: CsvDialect, edits: SpreadsheetCellEdit[]): Buffer {
  const next = rows.map((row) => [...row]);
  let maxRow = next.length; let maxColumn = next.reduce((max, row) => Math.max(max, row.length), 1);
  for (const edit of edits) {
    if (edit.sheetId !== 'csv-sheet-1') throw new SpreadsheetEditValidationError('The CSV worksheet is invalid');
    const coordinates = parseCellAddress(edit.cell); if (!coordinates) throw new SpreadsheetEditValidationError('The CSV cell address is invalid');
    if (coordinates.row > SPREADSHEET_LIMITS.maxCsvRows || coordinates.column > SPREADSHEET_LIMITS.maxCsvColumns) throw new SpreadsheetEditValidationError('The CSV cell is outside the editable range');
    while (next.length < coordinates.row) next.push([]);
    while ((next[coordinates.row - 1]?.length ?? 0) < coordinates.column) next[coordinates.row - 1].push('');
    next[coordinates.row - 1][coordinates.column - 1] = edit.value === null ? '' : String(edit.value);
    maxRow = Math.max(maxRow, coordinates.row); maxColumn = Math.max(maxColumn, coordinates.column);
  }
  const lines = next.slice(0, maxRow).map((row) => row.slice(0, maxColumn).map((field) => {
    const value = field ?? ''; return value.includes(dialect.delimiter) || /["\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }).join(dialect.delimiter));
  const body = lines.join(dialect.lineEnding) + (dialect.trailingNewline && lines.length ? dialect.lineEnding : '');
  return Buffer.from(`${dialect.bom ? '\uFEFF' : ''}${body}`, 'utf8');
}
