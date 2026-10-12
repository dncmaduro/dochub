export type TextFileFormat = 'text' | 'markdown' | 'json' | 'xml';
export type TextLineEnding = 'lf' | 'crlf' | 'mixed' | 'none';

export interface TextFileModel {
  version: 1;
  format: TextFileFormat;
  content: string;
  /** Safe, non-HTML representation used by structured/Markdown previewers. */
  previewContent: string;
  parseError: string | null;
  encoding: 'utf-8';
  bom: boolean;
  lineEnding: TextLineEnding;
  editable: boolean;
  readOnlyReason?: string;
  storageRevision?: string;
}

