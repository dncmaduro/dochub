import { SPREADSHEET_LIMITS } from './spreadsheet-limits.js';
import { parseCellAddress } from './xlsx-parser.js';
import type { SpreadsheetValue } from './workbook-model.js';

export class SpreadsheetEditValidationError extends Error {
  readonly expected = true;
  constructor(message: string) { super(message); this.name = 'SpreadsheetEditValidationError'; }
}
export interface SpreadsheetCellEdit { sheetId: string; cell: string; value: SpreadsheetValue; }
export interface SpreadsheetPatchRequest { expectedRevision: string; edits: SpreadsheetCellEdit[]; operationId?: string; }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function value(value: unknown): value is SpreadsheetValue { return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'; }
export function parseSpreadsheetPatchRequest(input: unknown): SpreadsheetPatchRequest {
  if (!record(input) || typeof input.expectedRevision !== 'string' || !input.expectedRevision || !Array.isArray(input.edits)) throw new SpreadsheetEditValidationError('Invalid spreadsheet save request');
  if (input.operationId !== undefined && (typeof input.operationId !== 'string' || input.operationId.length > 200)) throw new SpreadsheetEditValidationError('Invalid operation ID');
  if (input.edits.length > SPREADSHEET_LIMITS.maxEdits) throw new SpreadsheetEditValidationError('Too many spreadsheet edits');
  const edits: SpreadsheetCellEdit[] = []; const seen = new Set<string>();
  for (const raw of input.edits) {
    if (!record(raw) || typeof raw.sheetId !== 'string' || typeof raw.cell !== 'string' || !value(raw.value)) throw new SpreadsheetEditValidationError('Invalid spreadsheet cell edit');
    const cell = raw.cell.trim().toUpperCase();
    if (!parseCellAddress(cell)) throw new SpreadsheetEditValidationError('Invalid spreadsheet cell address');
    if (raw.sheetId.length < 1 || raw.sheetId.length > 200 || cell.length > 12) throw new SpreadsheetEditValidationError('Invalid spreadsheet cell identity');
    if (typeof raw.value === 'string' && raw.value.length > SPREADSHEET_LIMITS.maxCellText) throw new SpreadsheetEditValidationError('Spreadsheet cell text is too long');
    if (typeof raw.value === 'number' && !Number.isFinite(raw.value)) throw new SpreadsheetEditValidationError('Spreadsheet number is invalid');
    const key = `${raw.sheetId}\u0000${cell}`;
    if (seen.has(key)) throw new SpreadsheetEditValidationError('Duplicate spreadsheet cell edit');
  seen.add(key); edits.push({ sheetId: raw.sheetId, cell, value: raw.value });
  }
  return { expectedRevision: input.expectedRevision, edits, ...(typeof input.operationId === 'string' && input.operationId ? { operationId: input.operationId } : {}) };
}
