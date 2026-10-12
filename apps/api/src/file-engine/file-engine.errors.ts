export class FileEngineError extends Error {
  constructor(
    message: string,
    readonly code = 'FILE_ENGINE_FAILED',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class FilePreviewUnavailableError extends FileEngineError {
  constructor(message = 'Preview is unavailable.') {
    super(message, 'FILE_PREVIEW_UNAVAILABLE');
  }
}

export class FileFormatUnsupportedError extends FileEngineError {
  constructor(message = 'This file format is not supported.') {
    super(message, 'FILE_FORMAT_UNSUPPORTED');
  }
}

export class FileEngineFailedError extends FileEngineError {
  constructor(message = 'The file engine could not open this file.') {
    super(message, 'FILE_ENGINE_FAILED');
  }
}
