import { Readable } from 'node:stream';
import { BaseFileEngine } from './base.engine.js';
import { extensionFromFilename } from '../file-engine.types.js';
import { FileFormatUnsupportedError } from '../file-engine.errors.js';
import { StorageConflictError } from '../../storage/storage.errors.js';
import { parseSpreadsheetPatchRequest } from '../spreadsheet/spreadsheet-edit.types.js';
import { parseCsv } from '../spreadsheet/csv-parser.js';
import { serializeCsv } from '../spreadsheet/csv-serializer.js';
import { SpreadsheetPackageError, XlsxPackageReader } from '../spreadsheet/xlsx-package-reader.js';
import { XlsxParser } from '../spreadsheet/xlsx-parser.js';
import { XlsxPatcher } from '../spreadsheet/xlsx-patcher.js';
import type { WorkbookModel, SheetModel } from '../spreadsheet/workbook-model.js';
import type {
  FileDescriptor,
  FileEngineCapabilities,
  FileEngineModelContext,
  FileEngineOpenContext,
  FileEngineSaveContext,
  FilePreviewContent,
  FilePreviewResult,
  PreparedFileSave,
} from '../file-engine.types.js';
import { readSourceBytes } from '../file-engine.types.js';

export const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_MIME_TYPES = new Set(['text/csv', 'application/csv']);
const XLS_MIME_TYPES = new Set(['application/vnd.ms-excel', 'application/msexcel']);

export function isXlsxFile(file: FileDescriptor): boolean {
  const mime = file.mimeType?.trim().toLowerCase() ?? '';
  if (mime === XLSX_MIME_TYPE) return true;
  if (mime && !['application/octet-stream', 'binary/octet-stream'].includes(mime) && (CSV_MIME_TYPES.has(mime) || XLS_MIME_TYPES.has(mime))) return false;
  const extension = (file.extension ?? extensionFromFilename(file.name) ?? '').toLowerCase();
  return extension === '.xlsx';
}
export function isCsvFile(file: FileDescriptor): boolean {
  const mime = file.mimeType?.trim().toLowerCase() ?? '';
  if (CSV_MIME_TYPES.has(mime)) return true;
  const extension = (file.extension ?? extensionFromFilename(file.name) ?? '').toLowerCase();
  return (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') && extension === '.csv';
}
export function isXlsFile(file: FileDescriptor): boolean {
  const mime = file.mimeType?.trim().toLowerCase() ?? '';
  if (XLS_MIME_TYPES.has(mime)) return true;
  const extension = (file.extension ?? extensionFromFilename(file.name) ?? '').toLowerCase();
  return extension === '.xls' && !isXlsxFile(file);
}

async function readCsvBytes(context: FileEngineModelContext, file: FileDescriptor): Promise<Buffer> {
  if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native CSV preview.');
  return XlsxPackageReader.readStorageBytes(context.storage, file.storageRef);
}

export class SpreadsheetEngine extends BaseFileEngine {
  readonly id = 'SPREADSHEET' as const;
  readonly priority = 70;
  protected readonly mimeTypes = new Set([...XLS_MIME_TYPES, XLSX_MIME_TYPE, ...CSV_MIME_TYPES]);
  protected readonly extensions = new Set(['.xls', '.xlsx', '.csv']);

  capabilities(file: FileDescriptor): FileEngineCapabilities {
    return { ...this.defaultCapabilities, edit: (isXlsxFile(file) || isCsvFile(file)) && Boolean(file.storageRef) };
  }

  async openPreview(file: FileDescriptor): Promise<FilePreviewResult> {
    if (isXlsxFile(file)) return { kind: 'spreadsheet', mimeType: XLSX_MIME_TYPE };
    if (isCsvFile(file)) return { kind: 'spreadsheet', mimeType: 'text/csv' };
    return { kind: 'pdf', mimeType: 'application/pdf' };
  }

  async openContent(file: FileDescriptor, context: FileEngineOpenContext): Promise<FilePreviewContent> {
    if (isXlsxFile(file) || isCsvFile(file)) return this.openStoredContent(file, context);
    if (!context.openLibreOfficePreview) throw new Error('Office preview adapter is unavailable.');
    return context.openLibreOfficePreview(file);
  }

  async openModel(file: FileDescriptor, context: FileEngineModelContext): Promise<WorkbookModel> {
    if (!isXlsxFile(file) && !isCsvFile(file)) throw new FileFormatUnsupportedError('Native spreadsheet preview supports XLSX and CSV only.');
    if (isCsvFile(file)) return this.csvWorkbook(parseCsv(await readCsvBytes(context, file)).sheet, context.storageRevision);
    const reader = await XlsxPackageReader.fromStorage(context.storage, file.storageRef!);
    return new XlsxParser(reader).workbook(context.storageRevision, true);
  }

  async openSheet(file: FileDescriptor, sheetId: string, context: FileEngineModelContext): Promise<SheetModel> {
    if (isCsvFile(file)) {
      if (sheetId !== 'csv-sheet-1') throw new SpreadsheetPackageError('The requested worksheet is unavailable');
      return parseCsv(await readCsvBytes(context, file)).sheet;
    }
    if (!isXlsxFile(file)) throw new FileFormatUnsupportedError('Native spreadsheet preview supports XLSX and CSV only.');
    const reader = await XlsxPackageReader.fromStorage(context.storage, file.storageRef!);
    return new XlsxParser(reader).sheet(sheetId);
  }

  async prepareSave(file: FileDescriptor, model: unknown, context: FileEngineSaveContext): Promise<PreparedFileSave> {
    if (!isXlsxFile(file) && !isCsvFile(file)) throw new FileFormatUnsupportedError('Native spreadsheet editing supports XLSX and CSV only.');
    if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native spreadsheet editing.');
    const request = parseSpreadsheetPatchRequest(model);
    if (request.expectedRevision !== context.expectedRevision) throw new StorageConflictError('Storage object revision has changed');
    const source = context.source ?? { stat: () => context.storage.stat(file.storageRef!), openRead: () => context.storage.openRead(file.storageRef!) };
    const current = await source.stat();
    if (current.revision !== request.expectedRevision) throw new StorageConflictError('Storage object revision has changed');
    const sourceBytes = await readSourceBytes(source);
    let output: Buffer;
    let mimeType: string;
    if (isCsvFile(file)) {
      const csv = parseCsv(sourceBytes);
      output = serializeCsv(csv.rows, csv.dialect, request.edits);
      mimeType = 'text/csv';
    } else {
      output = XlsxPatcher.apply(sourceBytes, request).bytes;
      mimeType = XLSX_MIME_TYPE;
    }
    return { stream: Readable.from([output]), mimeType, sizeBytes: BigInt(output.byteLength) };
  }

  async save(file: FileDescriptor, model: unknown, context: FileEngineSaveContext): Promise<{ storageRevision: string; model: WorkbookModel }> {
    if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native spreadsheet editing.');
    const request = parseSpreadsheetPatchRequest(model);
    const prepared = await this.prepareSave(file, model, context);
    const stored = await context.storage.replace(file.storageRef, { stream: prepared.stream, mimeType: prepared.mimeType }, { expectedRevision: context.expectedRevision });
    if (!stored.metadata.revision) throw new Error('Storage provider did not return a new revision');
    const savedModel = await this.openModel(file, { ...context, storageRevision: stored.metadata.revision });
    if (savedModel.formulasPresent && request.edits.length) savedModel.calculatedValuesStale = true;
    return { storageRevision: stored.metadata.revision, model: savedModel };
  }

  private csvWorkbook(sheet: SheetModel, storageRevision?: string): WorkbookModel {
    return { version: 1, id: 'csv-workbook', sheets: [{ id: sheet.id, name: sheet.name, position: 0, rowCount: sheet.dimensions.rowCount, columnCount: sheet.dimensions.columnCount }], activeSheetId: sheet.id, editable: true, ...(storageRevision ? { storageRevision } : {}), hasUnsupportedContent: false, formulasPresent: false, calculatedValuesStale: false };
  }
}
