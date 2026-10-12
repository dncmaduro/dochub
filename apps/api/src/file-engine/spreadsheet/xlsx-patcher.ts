import { XMLValidator } from 'fast-xml-parser';
import { zipSync } from 'fflate';
import { parseCellAddress, cellAddress, XlsxParser } from './xlsx-parser.js';
import { SpreadsheetEditValidationError, type SpreadsheetPatchRequest } from './spreadsheet-edit.types.js';
import { SPREADSHEET_LIMITS } from './spreadsheet-limits.js';
import { SpreadsheetPackageError, XlsxPackageReader } from './xlsx-package-reader.js';
import type { SpreadsheetValue } from './workbook-model.js';

interface Replacement { start: number; end: number; value: string; }
function escapeXml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function applyReplacements(source: string, replacements: Replacement[]): string { return [...replacements].sort((left, right) => right.start - left.start || right.end - left.end).reduce((current, replacement) => current.slice(0, replacement.start) + replacement.value + current.slice(replacement.end), source); }
function cellColumn(address: string): number { return parseCellAddress(address)?.column ?? 0; }
function findCell(xml: string, address: string): { start: number; end: number; xml: string } | null {
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`<c\\b(?=[^>]*\\br\\s*=\\s*(["'])${escaped}\\1)[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`, 'iu');
  const match = pattern.exec(xml); return match ? { start: match.index, end: match.index + match[0].length, xml: match[0] } : null;
}
function rowBlock(xml: string, row: number): { start: number; end: number; closeStart: number; xml: string } | null {
  const pattern = new RegExp(`<row\\b(?=[^>]*\\br\\s*=\\s*(["'])${row}\\1)[^>]*>[\\s\\S]*?<\\/row>`, 'iu');
  const match = pattern.exec(xml); if (!match) return null;
  return { start: match.index, end: match.index + match[0].length, closeStart: match.index + match[0].lastIndexOf('</row>'), xml: match[0] };
}
function sheetDataBounds(xml: string): { start: number; closeStart: number } | null {
  const match = /<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/iu.exec(xml); return match ? { start: match.index, closeStart: match.index + match[0].lastIndexOf('</sheetData>') } : null;
}
function mergeContains(range: string, address: string): { ghost: boolean; topLeft: boolean } {
  const [from, to = from] = range.replaceAll('$', '').split(':'); const start = parseCellAddress(from ?? ''); const end = parseCellAddress(to ?? ''); const current = parseCellAddress(address);
  if (!start || !end || !current || current.row < Math.min(start.row, end.row) || current.row > Math.max(start.row, end.row) || current.column < Math.min(start.column, end.column) || current.column > Math.max(start.column, end.column)) return { ghost: false, topLeft: false };
  return { ghost: current.row !== start.row || current.column !== start.column, topLeft: true };
}
function cellBody(value: SpreadsheetValue): { type?: string; body: string } {
  if (value === null) return { body: '' };
  if (typeof value === 'string') {
    if (value.startsWith('=')) throw new SpreadsheetEditValidationError('Formula editing is not supported');
    const preserve = /^\s/u.test(value) || /\s$/u.test(value);
    return { type: 'inlineStr', body: `<is><t${preserve ? ' xml:space="preserve"' : ''}>${escapeXml(value)}</t></is>` };
  }
  if (typeof value === 'boolean') return { type: 'b', body: `<v>${value ? '1' : '0'}</v>` };
  if (!Number.isFinite(value)) throw new SpreadsheetEditValidationError('Spreadsheet number is invalid');
  return { body: `<v>${String(value)}</v>` };
}
function patchCell(xml: string, address: string, value: SpreadsheetValue): string {
  const openEnd = xml.indexOf('>'); if (openEnd < 0) throw new SpreadsheetEditValidationError('Spreadsheet cell XML is invalid');
  const open = xml.slice(0, openEnd + 1);
  const attributes = open.replace(/\s+t\s*=\s*(["']).*?\1/iu, ''); const encoded = cellBody(value);
  const nextOpen = attributes.replace(/\/\s*>$/u, '>').replace(/>$/u, `${encoded.type ? ` t="${encoded.type}"` : ''}>`);
  return `${nextOpen}${encoded.body}</c>`;
}
function newCell(address: string, value: SpreadsheetValue): string { const encoded = cellBody(value); return `<c r="${address}"${encoded.type ? ` t="${encoded.type}"` : ''}>${encoded.body}</c>`; }
function updateDimension(xml: string, maxRow: number, maxColumn: number): string {
  const match = /<dimension\b([^>]*)>/iu.exec(xml); if (!match) return xml;
  const refMatch = /\bref\s*=\s*(["'])(.*?)\1/iu.exec(match[1] ?? ''); if (!refMatch) return xml;
  const existing = refMatch[2] ?? 'A1'; const parts = existing.replaceAll('$', '').split(':'); const start = parseCellAddress(parts[0] ?? '') ?? { row: 1, column: 1 }; const end = parseCellAddress(parts[1] ?? parts[0] ?? '') ?? start;
  const endRow = Math.max(end.row, maxRow); const endColumn = Math.max(end.column, maxColumn); const nextRef = start.row === 1 && start.column === 1 && endRow === 1 && endColumn === 1 ? 'A1' : `${cellAddress(start.row, start.column)}:${cellAddress(endRow, endColumn)}`;
  const replacement = match[0].replace(refMatch[0], `ref=${refMatch[1]}${nextRef}${refMatch[1]}`); return xml.slice(0, match.index) + replacement + xml.slice(match.index + match[0].length);
}
function patchCalcProperties(xml: string): string {
  const existing = /<calcPr\b([^>]*)\/>/iu.exec(xml);
  if (existing) {
    const attributes = existing[1] ?? ''; const add = (name: string, value: string) => new RegExp(`\\s${name}\\s*=`, 'iu').test(attributes) ? attributes.replace(new RegExp(`(\\s${name}\\s*=\\s*["']).*?(["'])`, 'iu'), `$1${value}$2`) : `${attributes} ${name}="${value}"`;
    const withMode = add('calcMode', 'auto');
    const withFullCalc = /\sfullCalcOnLoad\s*=/iu.test(withMode)
      ? withMode.replace(/(\sfullCalcOnLoad\s*=\s*["']).*?(["'])/iu, (_match, start: string, end: string) => `${start}1${end}`)
      : `${withMode} fullCalcOnLoad="1"`;
    const attributesWithForce = /\sforceFullCalc\s*=/iu.test(withFullCalc)
      ? withFullCalc.replace(/(\sforceFullCalc\s*=\s*["']).*?(["'])/iu, (_match, start: string, end: string) => `${start}1${end}`)
      : `${withFullCalc} forceFullCalc="1"`;
    const next = `<calcPr${attributesWithForce}/>`;
    return xml.slice(0, existing.index) + next + xml.slice(existing.index + existing[0].length);
  }
  return xml.replace(/<\/workbook>/iu, '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>');
}

export class XlsxPatcher {
  static assertWithinLimits(request: SpreadsheetPatchRequest): void { if (request.edits.length > SPREADSHEET_LIMITS.maxEdits) throw new SpreadsheetEditValidationError('Too many spreadsheet edits'); }
  static apply(sourceBytes: Uint8Array, request: SpreadsheetPatchRequest): { bytes: Buffer } {
    this.assertWithinLimits(request);
    const reader = XlsxPackageReader.fromBytes(sourceBytes); const parser = new XlsxParser(reader);
    const bySheet = new Map<string, typeof request.edits>();
    for (const edit of request.edits) { const group = bySheet.get(edit.sheetId) ?? []; group.push(edit); bySheet.set(edit.sheetId, group); }
    const entries: Record<string, Uint8Array> = {}; for (const [path, bytes] of reader.allEntries()) entries[path] = bytes;
    for (const [sheetId, edits] of bySheet) {
      const path = parser.sheetPath(sheetId); if (!path) throw new SpreadsheetEditValidationError('The worksheet does not exist');
      const model = parser.sheet(sheetId); let xml = reader.text(path); if (XMLValidator.validate(xml) !== true) throw new SpreadsheetPackageError('XLSX worksheet XML is malformed');
      const replacements: Replacement[] = []; const rowAdditions = new Map<number, Array<{ address: string; value: SpreadsheetValue }>>(); const newRows = new Map<number, Array<{ address: string; value: SpreadsheetValue }>>();
      for (const edit of edits) {
        const coordinates = parseCellAddress(edit.cell); if (!coordinates) throw new SpreadsheetEditValidationError('The worksheet cell is invalid');
        const merge = model.mergedRanges.map((range) => mergeContains(range, edit.cell)).find((entry) => entry.ghost || entry.topLeft);
        if (merge?.ghost) throw new SpreadsheetEditValidationError('Merged ghost cells are read-only');
        const found = findCell(xml, edit.cell);
        if (found) {
          if (/<f(?:\s|>)/iu.test(found.xml)) throw new SpreadsheetEditValidationError('Formula cells are read-only');
          replacements.push({ start: found.start, end: found.end, value: patchCell(found.xml, edit.cell, edit.value) });
          continue;
        }
        const existingRow = rowBlock(xml, coordinates.row);
        if (existingRow) (rowAdditions.get(coordinates.row) ?? (rowAdditions.set(coordinates.row, []), rowAdditions.get(coordinates.row)!)).push({ address: edit.cell, value: edit.value });
        else (newRows.get(coordinates.row) ?? (newRows.set(coordinates.row, []), newRows.get(coordinates.row)!)).push({ address: edit.cell, value: edit.value });
      }
      for (const [rowNumber, additions] of rowAdditions) {
        const row = rowBlock(xml, rowNumber); if (!row) continue;
        const grouped = new Map<number, string[]>();
        for (const addition of additions.sort((a, b) => cellColumn(a.address) - cellColumn(b.address))) { const cell = newCell(addition.address, addition.value); const existing = grouped.get(cellColumn(addition.address)) ?? []; existing.push(cell); grouped.set(cellColumn(addition.address), existing); }
        const cells = [...row.xml.matchAll(/<c\b[^>]*\br\s*=\s*(["'])([A-Z]+\d+)\1[^>]*(?:\/>|>[\s\S]*?<\/c>)/giu)].map((match) => ({ column: cellColumn(match[2] ?? ''), offset: (match.index ?? 0) + (match[0]?.indexOf('<c') ?? 0) }));
        for (const [column, values] of grouped) { const target = cells.find((cell) => cell.column > column); const absolute = target ? row.start + target.offset : row.closeStart; replacements.push({ start: absolute, end: absolute, value: values.join('') }); }
      }
      if (newRows.size) {
        const data = sheetDataBounds(xml); if (!data) throw new SpreadsheetEditValidationError('The worksheet has no editable sheet data');
        const rowMatches = [...xml.slice(data.start, data.closeStart).matchAll(/<row\b[^>]*\br\s*=\s*(["'])(\d+)\1/giu)].map((match) => ({ row: Number(match[2]), offset: data.start + (match.index ?? 0) }));
        const insertionGroups = new Map<number, string[]>();
        for (const [rowNumber, additions] of [...newRows.entries()].sort(([a], [b]) => a - b)) { const rowXml = `<row r="${rowNumber}">${additions.sort((a, b) => cellColumn(a.address) - cellColumn(b.address)).map((addition) => newCell(addition.address, addition.value)).join('')}</row>`; const target = rowMatches.find((row) => row.row > rowNumber); const offset = target?.offset ?? data.closeStart; const group = insertionGroups.get(offset) ?? []; group.push(rowXml); insertionGroups.set(offset, group); }
        for (const [offset, values] of insertionGroups) replacements.push({ start: offset, end: offset, value: values.join('') });
      }
      const maxRow = Math.max(model.dimensions.rowCount, ...edits.map((edit) => parseCellAddress(edit.cell)?.row ?? 1)); const maxColumn = Math.max(model.dimensions.columnCount, ...edits.map((edit) => parseCellAddress(edit.cell)?.column ?? 1));
      xml = applyReplacements(xml, replacements); xml = updateDimension(xml, maxRow, maxColumn); entries[path] = new TextEncoder().encode(xml);
    }
    if (request.edits.length && [...reader.allEntries().keys()].some((path) => /^xl\/worksheets\/[^/]+\.xml$/iu.test(path) && /<f(?:\s|>)/iu.test(reader.text(path)))) entries['xl/workbook.xml'] = new TextEncoder().encode(patchCalcProperties(reader.text('xl/workbook.xml')));
    return { bytes: Buffer.from(zipSync(entries)) };
  }
}
