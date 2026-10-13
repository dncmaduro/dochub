import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { SPREADSHEET_LIMITS } from './spreadsheet-limits.js';
import type { CellModel, SheetDescriptor, SheetModel, SpreadsheetCellStyle, SpreadsheetValue, WorkbookModel } from './workbook-model.js';
import { SpreadsheetPackageError, type XlsxFailureKind, type XlsxPackageReader } from './xlsx-package-reader.js';

type XmlNode = Record<string, unknown>;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  htmlEntities: false,
});

function object(value: unknown): XmlNode | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as XmlNode : null; }
function nodes(value: unknown): XmlNode[] {
  if (Array.isArray(value)) return value.flatMap((item) => object(item) ? [object(item)!] : []);
  const node = object(value); return node ? [node] : [];
}
function namedValue(node: XmlNode | null, name: string): unknown {
  if (!node) return undefined;
  if (node[name] !== undefined) return node[name];
  return Object.entries(node).find(([key]) => localName(key) === name)?.[1];
}
function localName(name: string): string { const separator = name.lastIndexOf(':'); return separator >= 0 ? name.slice(separator + 1) : name; }
function child(node: XmlNode | null, name: string): XmlNode | null {
  return object(namedValue(node, name));
}
function children(node: XmlNode | null, name: string): XmlNode[] {
  if (!node) return [];
  return Object.entries(node).filter(([key]) => localName(key) === name).flatMap(([, value]) => nodes(value));
}
function attr(node: XmlNode | null, ...names: string[]): string | null {
  if (!node) return null;
  for (const name of names) {
    const value = node?.[`@_${name}`];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  const localNames = new Set(names.map(localName));
  const namespaced = Object.entries(node).find(([key, value]) => key.startsWith('@_') && localNames.has(localName(key.slice(2))) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'));
  if (namespaced) return String(namespaced[1]);
  return null;
}
function hasChild(node: XmlNode | null, name: string): boolean { return Boolean(node && Object.keys(node).some((key) => localName(key) === name)); }
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
  const record = object(node);
  if (!record) return '';
  const value = record['#text'];
  if (Array.isArray(value)) return value.filter((item): item is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof item)).map(String).join('');
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}
function descendantText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
  const record = object(node);
  if (!record) return '';
  node = record;
  const typedNode = node as XmlNode;
  const direct = text(typedNode);
  if (direct) return direct;
  return Object.entries(typedNode).filter(([key]) => !key.startsWith('@_') && key !== '#text').map(([, value]) => descendantText(value)).join('');
}
function parseXml(xml: string, label: string, failureKind: XlsxFailureKind = 'corrupt'): XmlNode {
  try {
    if (XMLValidator.validate(xml) !== true) throw new Error('invalid XML');
    const value = parser.parse(xml);
    if (!value || typeof value !== 'object') throw new Error('empty XML');
    return value as XmlNode;
  } catch (error) {
    if (error instanceof SpreadsheetPackageError) throw error;
    throw new SpreadsheetPackageError(`XLSX XML part is malformed: ${label}`, failureKind);
  }
}
function numberValue(value: string | null): number | null { const parsed = value === null ? NaN : Number(value); return Number.isFinite(parsed) ? parsed : null; }
function colFromAddress(address: string): number { let result = 0; for (const char of address.replace(/\d+$/u, '').toUpperCase()) result = result * 26 + char.charCodeAt(0) - 64; return result; }
export function columnName(column: number): string { let result = ''; let value = column; while (value > 0) { const remainder = (value - 1) % 26; result = String.fromCharCode(65 + remainder) + result; value = Math.floor((value - 1) / 26); } return result || 'A'; }
export function cellAddress(row: number, column: number): string { return `${columnName(column)}${row}`; }
export function parseCellAddress(address: string): { row: number; column: number } | null {
  const normalized = address.trim().toUpperCase();
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/u.exec(normalized);
  if (!match) return null;
  const column = colFromAddress(normalized);
  const row = Number(match[2]);
  return column >= 1 && column <= SPREADSHEET_LIMITS.maxColumns && row <= SPREADSHEET_LIMITS.maxRows ? { row, column } : null;
}
function rangeBounds(reference: string): { startRow: number; startColumn: number; endRow: number; endColumn: number } | null {
  const parts = reference.replace(/^.*!/u, '').replaceAll('$', '').split(':');
  const start = parseCellAddress(parts[0] ?? ''); const end = parseCellAddress(parts[1] ?? parts[0] ?? '');
  if (!start || !end) return null;
  return { startRow: Math.min(start.row, end.row), startColumn: Math.min(start.column, end.column), endRow: Math.max(start.row, end.row), endColumn: Math.max(start.column, end.column) };
}

interface StyleRecord { style?: SpreadsheetCellStyle; isDate: boolean; }
function rgb(node: XmlNode | null): string | null {
  const value = attr(node, 'rgb');
  return value && /^[A-F0-9]{6,8}$/iu.test(value) ? `#${value.slice(-6)}` : null;
}
function builtinFormat(id: number): string | null {
  const formats: Record<number, string> = { 1: '0', 2: '0.00', 9: '0%', 10: '0.00%', 14: 'm/d/yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm' };
  return formats[id] ?? null;
}
function isDateFormat(format: string | null): boolean { return Boolean(format && /(^|[^a-z])[dyhms](?:[^a-z]|$)/iu.test(format.replace(/\[[^\]]*\]/gu, ''))); }

class Styles {
  private readonly styles: StyleRecord[] = [];
  static from(reader: XlsxPackageReader): Styles {
    const result = new Styles();
    if (!reader.has('xl/styles.xml')) return result;
    const root = parseXml(reader.text('xl/styles.xml'), 'xl/styles.xml', 'styles');
    const sheet = child(root, 'styleSheet');
    const formats = new Map<number, string>();
    for (const format of children(child(sheet, 'numFmts'), 'numFmt')) {
      const id = numberValue(attr(format, 'numFmtId')); const code = attr(format, 'formatCode');
      if (id !== null && code) formats.set(id, code);
    }
    const fonts = children(child(sheet, 'fonts'), 'font');
    const fills = children(child(sheet, 'fills'), 'fill');
    const borders = children(child(sheet, 'borders'), 'border');
    for (const xf of children(child(sheet, 'cellXfs'), 'xf')) {
      const font = fonts[numberValue(attr(xf, 'fontId')) ?? -1];
      const fill = fills[numberValue(attr(xf, 'fillId')) ?? -1];
      const border = borders[numberValue(attr(xf, 'borderId')) ?? -1];
      const formatId = numberValue(attr(xf, 'numFmtId')) ?? 0;
      const numberFormat = formats.get(formatId) ?? builtinFormat(formatId);
      const alignment = child(xf, 'alignment');
      const style: SpreadsheetCellStyle = {
        bold: font?.['b'] !== undefined || undefined,
        italic: font?.['i'] !== undefined || undefined,
        underline: font?.['u'] !== undefined || undefined,
        fontSize: numberValue(attr(child(font, 'sz'), 'val')),
        textColor: rgb(child(font, 'color')),
        fillColor: rgb(child(child(fill, 'patternFill'), 'fgColor')),
        horizontalAlign: (attr(alignment, 'horizontal') as SpreadsheetCellStyle['horizontalAlign']) ?? 'general',
        verticalAlign: (attr(alignment, 'vertical') as SpreadsheetCellStyle['verticalAlign']) ?? 'bottom',
        numberFormat: numberFormat ?? null,
        borders: border ? {
          left: attr(child(border, 'left'), 'style'), right: attr(child(border, 'right'), 'style'),
          top: attr(child(border, 'top'), 'style'), bottom: attr(child(border, 'bottom'), 'style'),
        } : undefined,
      };
      result.styles.push({ style, isDate: isDateFormat(numberFormat) });
    }
    return result;
  }
  get(id: number): StyleRecord { return this.styles[id] ?? { isDate: false }; }
}

interface SheetInfo { descriptor: SheetDescriptor; path: string; }
interface SharedStrings { values: string[]; }
function readSharedStrings(reader: XlsxPackageReader): SharedStrings {
  if (!reader.has('xl/sharedStrings.xml')) return { values: [] };
  const root = parseXml(reader.text('xl/sharedStrings.xml'), 'xl/sharedStrings.xml', 'shared-strings');
  const result: string[] = [];
  for (const item of children(child(root, 'sst'), 'si')) {
    if (result.length >= SPREADSHEET_LIMITS.maxSharedStrings) throw new SpreadsheetPackageError('XLSX shared strings exceed the model limit', 'model-limit');
    result.push(descendantText(item));
  }
  return { values: result };
}

function parseScalar(raw: string, type: string | null, shared: SharedStrings, style: StyleRecord): { value: SpreadsheetValue; valueType: CellModel['valueType']; displayValue: string; cachedValue?: SpreadsheetValue } {
  if (type === 's') {
    const value = shared.values[Number(raw)];
    if (value === undefined) throw new SpreadsheetPackageError('XLSX shared string index is invalid', 'shared-strings');
    return { value, valueType: 'string', displayValue: value };
  }
  if (type === 'inlineStr') return { value: raw, valueType: 'string', displayValue: raw };
  if (type === 'str') return { value: raw, valueType: 'string', displayValue: raw };
  if (type === 'b') { const value = raw === '1' || raw.toLowerCase() === 'true'; return { value, valueType: 'boolean', displayValue: value ? 'TRUE' : 'FALSE' }; }
  if (type === 'e') return { value: raw, valueType: 'error', displayValue: raw };
  if (type === 'd') return { value: raw, valueType: raw.includes('T') ? 'datetime' : 'date', displayValue: raw };
  const numeric = Number(raw);
  if (raw === '') return { value: null, valueType: 'blank', displayValue: '' };
  if (Number.isNaN(numeric)) return { value: raw, valueType: 'string', displayValue: raw };
  if (style.isDate) {
    const date = new Date(Date.UTC(1899, 11, 30) + numeric * 86_400_000);
    const displayValue = Number.isNaN(date.getTime()) ? raw : date.toISOString().replace('T', ' ').replace('.000Z', 'Z');
    return { value: numeric, valueType: style.style?.numberFormat?.includes('h') ? 'datetime' : 'date', displayValue };
  }
  const format = style.style?.numberFormat ?? '';
  if (format.includes('%')) return { value: numeric, valueType: 'number', displayValue: `${(numeric * 100).toFixed(format.includes('0.00') ? 2 : 0)}%` };
  if (format.includes('$') || format.includes('€') || format.includes('£')) return { value: numeric, valueType: 'number', displayValue: `${format.includes('€') ? '€' : format.includes('£') ? '£' : '$'}${numeric}` };
  return { value: numeric, valueType: 'number', displayValue: String(numeric) };
}

function unsupportedContent(reader: XlsxPackageReader): boolean {
  return [...reader.allEntries().keys()].some((path) => /(?:^|\/)(?:drawings|charts|tables|pivotTables|pivotCache|externalLinks|media|customXml)(?:\/|$)|vbaProject/iu.test(path));
}

export class XlsxParser {
  private readonly styles: Styles;
  private readonly shared: SharedStrings;
  private readonly sheets: SheetInfo[];
  private readonly formulas: boolean;
  private readonly activeIndex: number;
  constructor(private readonly reader: XlsxPackageReader) {
    this.styles = Styles.from(reader);
    this.shared = readSharedStrings(reader);
    const workbook = parseXml(reader.text('xl/workbook.xml'), 'xl/workbook.xml', 'workbook');
    const workbookView = children(child(child(workbook, 'workbook'), 'bookViews'), 'workbookView')[0];
    this.activeIndex = numberValue(attr(workbookView, 'activeTab')) ?? 0;
    const relsRoot = parseXml(reader.text('xl/_rels/workbook.xml.rels'), 'xl/_rels/workbook.xml.rels', 'relationships');
    const relationships = new Map(children(child(relsRoot, 'Relationships'), 'Relationship').map((rel) => [attr(rel, 'Id') ?? '', { target: attr(rel, 'Target') ?? '', external: attr(rel, 'TargetMode') === 'External' }]));
    const sheets = children(child(child(workbook, 'workbook'), 'sheets'), 'sheet');
    this.sheets = sheets.flatMap((sheet, index) => {
      const relId = attr(sheet, 'r:id', 'id'); const relationship = relId ? relationships.get(relId) : undefined;
      const path = relationship && !relationship.external ? reader.resolveTarget('xl/workbook.xml', relationship.target) : null;
      const name = attr(sheet, 'name') ?? `Sheet ${index + 1}`;
      if (!path) return [];
      const id = `s-${Buffer.from(`${index}:${relId ?? path}`).toString('base64url')}`;
      const hidden = attr(sheet, 'state') === 'hidden' || attr(sheet, 'state') === 'veryHidden';
      return [{ descriptor: { id, name, position: index, ...(hidden ? { hidden: true } : {}), rowCount: 0, columnCount: 0 }, path }];
    });
    this.formulas = this.sheets.some(({ path }) => /<f(?:\s|>)/iu.test(reader.text(path)));
    if (!this.sheets.length) throw new SpreadsheetPackageError('XLSX workbook contains no readable sheets', 'relationships');
  }
  workbook(storageRevision?: string, editable = true): WorkbookModel {
    const descriptors = this.sheets.map(({ descriptor, path }) => {
      const bounds = this.readDimension(path);
      return { ...descriptor, rowCount: bounds.endRow, columnCount: bounds.endColumn };
    });
    const activeSheetId = descriptors[this.activeIndex]?.hidden ? (descriptors.find((sheet) => !sheet.hidden)?.id ?? descriptors[0].id) : descriptors[this.activeIndex]?.id ?? descriptors.find((sheet) => !sheet.hidden)?.id ?? descriptors[0].id;
    return { version: 1, id: 'xlsx-workbook', sheets: descriptors, activeSheetId, editable, ...(storageRevision ? { storageRevision } : {}), hasUnsupportedContent: unsupportedContent(this.reader), formulasPresent: this.formulas, calculatedValuesStale: false };
  }
  sheet(sheetId: string): SheetModel {
    const info = this.sheets.find((sheet) => sheet.descriptor.id === sheetId);
    if (!info) throw new SpreadsheetPackageError('The requested worksheet is unavailable');
    const root = parseXml(this.reader.text(info.path), info.path, 'worksheet');
    const worksheet = child(root, 'worksheet');
    const dimension = this.readDimension(info.path);
    const cells: CellModel[] = [];
    const rowMetadata: SheetModel['rowMetadata'] = {};
    const columnMetadata: SheetModel['columnMetadata'] = {};
    for (const col of children(child(worksheet, 'cols'), 'col')) {
      const start = Math.max(1, numberValue(attr(col, 'min')) ?? 1); const end = Math.min(SPREADSHEET_LIMITS.maxColumns, numberValue(attr(col, 'max')) ?? start);
      for (let column = start; column <= end; column += 1) columnMetadata[String(column)] = { ...(numberValue(attr(col, 'width')) !== null ? { widthPx: Math.min(500, Math.max(24, Math.round((numberValue(attr(col, 'width')) ?? 10) * 7))) } : {}), ...(attr(col, 'hidden') === '1' || attr(col, 'hidden') === 'true' ? { hidden: true } : {}) };
    }
    const sheetData = child(worksheet, 'sheetData');
    let previousRow = 0;
    for (const rowNode of children(sheetData, 'row')) {
      const row = numberValue(attr(rowNode, 'r')) ?? previousRow + 1;
      previousRow = row;
      if (row < 1 || row > SPREADSHEET_LIMITS.maxRows) continue;
      const height = numberValue(attr(rowNode, 'ht'));
      if (height !== null || attr(rowNode, 'hidden') === '1' || attr(rowNode, 'hidden') === 'true') rowMetadata[String(row)] = { ...(height !== null ? { heightPx: Math.min(400, Math.max(16, height * 1.333)) } : {}), ...(attr(rowNode, 'hidden') === '1' || attr(rowNode, 'hidden') === 'true' ? { hidden: true } : {}) };
      let previousColumn = 0;
      for (const cellNode of children(rowNode, 'c')) {
        if (cells.length >= SPREADSHEET_LIMITS.maxLoadedCells) throw new SpreadsheetPackageError('XLSX worksheet exceeds the loaded-cell model limit', 'model-limit');
        const address = attr(cellNode, 'r'); const coordinates = address ? parseCellAddress(address) : { row, column: previousColumn + 1 };
        if (!coordinates) continue;
        previousColumn = coordinates.column;
        const normalizedAddress = address?.toUpperCase() ?? cellAddress(row, coordinates.column);
        const styleId = numberValue(attr(cellNode, 's')) ?? 0; const style = this.styles.get(styleId);
        const formulaPresent = hasChild(cellNode, 'f');
        const formulaNode = formulaPresent ? child(cellNode, 'f') : null;
        const formulaText = formulaPresent ? text(formulaNode ?? namedValue(cellNode, 'f')) : '';
        const formula = formulaText || undefined;
        const raw = text(namedValue(cellNode, 'v'));
        const inline = descendantText(namedValue(cellNode, 'is'));
        const parsed = parseScalar(attr(cellNode, 't') === 'inlineStr' ? inline : raw, attr(cellNode, 't'), this.shared, style);
        const formulaCell = formulaPresent;
        cells.push({ address: normalizedAddress, row: coordinates.row, column: coordinates.column, ...parsed, valueType: formulaCell ? 'formula' : parsed.valueType, ...(formula ? { formula, cachedValue: parsed.value } : {}), ...(Object.keys(style.style ?? {}).length ? { style: style.style } : {}), ...(styleId ? { styleId } : {}), editable: !formulaCell, ...(formulaCell ? { readonlyReason: 'Formula cells are read-only until Docs Hub has a calculation engine.' } : {}) });
      }
    }
    const mergedRanges = children(child(worksheet, 'mergeCells'), 'mergeCell').flatMap((merge) => { const ref = attr(merge, 'ref'); return ref && rangeBounds(ref) ? [ref] : []; }).slice(0, SPREADSHEET_LIMITS.maxMergedRanges);
    for (const range of mergedRanges) {
      const bounds = rangeBounds(range); if (!bounds) continue;
      for (const cell of cells) if (cell.row >= bounds.startRow && cell.row <= bounds.endRow && cell.column >= bounds.startColumn && cell.column <= bounds.endColumn && (cell.row !== bounds.startRow || cell.column !== bounds.startColumn)) { cell.editable = false; cell.readonlyReason = 'Only the top-left cell of a merged range can be edited.'; }
    }
    const pane = child(child(worksheet, 'sheetViews'), 'sheetView');
    const paneNode = child(pane, 'pane');
    const frozenPane = paneNode ? { row: numberValue(attr(paneNode, 'ySplit')) ?? 0, column: numberValue(attr(paneNode, 'xSplit')) ?? 0 } : undefined;
    return { version: 1, id: info.descriptor.id, name: info.descriptor.name, dimensions: { rowCount: dimension.endRow, columnCount: dimension.endColumn }, cells, rowMetadata, columnMetadata, mergedRanges, ...(frozenPane ? { frozenPane } : {}) };
  }
  sheetPath(sheetId: string): string | null { return this.sheets.find((sheet) => sheet.descriptor.id === sheetId)?.path ?? null; }
  private readDimension(path: string): { endRow: number; endColumn: number } {
    const root = parseXml(this.reader.text(path), path, 'worksheet'); const worksheet = child(root, 'worksheet');
    let endRow = 1; let endColumn = 1; let previousRow = 0;
    for (const row of children(child(worksheet, 'sheetData'), 'row')) {
      const rowNumber = numberValue(attr(row, 'r')) ?? previousRow + 1;
      previousRow = rowNumber;
      if (rowNumber < 1 || rowNumber > SPREADSHEET_LIMITS.maxRows) continue;
      endRow = Math.max(endRow, rowNumber);
      let previousColumn = 0;
      for (const cell of children(row, 'c')) {
        const coordinates = parseCellAddress(attr(cell, 'r') ?? '') ?? { row: rowNumber, column: previousColumn + 1 };
        if (coordinates.row !== rowNumber || coordinates.column < 1 || coordinates.column > SPREADSHEET_LIMITS.maxColumns) continue;
        previousColumn = coordinates.column;
        endColumn = Math.max(endColumn, coordinates.column);
      }
    }
    return { endRow: Math.min(SPREADSHEET_LIMITS.maxRows, endRow), endColumn: Math.min(SPREADSHEET_LIMITS.maxColumns, endColumn) };
  }
}
