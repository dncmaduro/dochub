export type SpreadsheetValue = string | number | boolean | null;
export type SpreadsheetValueType = 'string' | 'number' | 'boolean' | 'blank' | 'date' | 'datetime' | 'error' | 'formula';

export interface SpreadsheetCellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number | null;
  textColor?: string | null;
  fillColor?: string | null;
  horizontalAlign?: 'left' | 'center' | 'right' | 'general';
  verticalAlign?: 'top' | 'center' | 'bottom';
  numberFormat?: string | null;
  borders?: Record<string, string | null>;
}

export interface CellModel {
  address: string;
  row: number;
  column: number;
  value: SpreadsheetValue;
  valueType: SpreadsheetValueType;
  displayValue: string;
  formula?: string;
  cachedValue?: SpreadsheetValue;
  style?: SpreadsheetCellStyle;
  styleId?: number;
  editable: boolean;
  readonlyReason?: string;
}

export interface SheetDescriptor {
  id: string;
  name: string;
  position: number;
  hidden?: boolean;
  rowCount: number;
  columnCount: number;
}

export interface SheetModel {
  version: 1;
  id: string;
  name: string;
  dimensions: { rowCount: number; columnCount: number };
  cells: CellModel[];
  rowMetadata: Record<string, { heightPx?: number; hidden?: boolean }>;
  columnMetadata: Record<string, { widthPx?: number; hidden?: boolean }>;
  mergedRanges: string[];
  frozenPane?: { row: number; column: number };
}

export interface WorkbookModel {
  version: 1;
  id: string;
  sheets: SheetDescriptor[];
  activeSheetId: string;
  editable: boolean;
  storageRevision?: string;
  hasUnsupportedContent?: boolean;
  formulasPresent?: boolean;
  calculatedValuesStale?: boolean;
}
