import path from 'node:path';

export interface StorageConfig {
  driver: 'local';
  root: string;
  uploadTempRoot: string;
  uploadMaxBytes: number;
}

export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');

function requiredAbsolutePath(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !path.isAbsolute(normalized)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return path.resolve(normalized);
}

function positiveInteger(name: string, value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/** Parses the API's storage settings once during Nest application bootstrap. */
export function loadStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): StorageConfig {
  if (env.STORAGE_DRIVER !== 'local') {
    throw new Error('STORAGE_DRIVER must be local');
  }
  return {
    driver: 'local',
    root: requiredAbsolutePath('STORAGE_ROOT', env.STORAGE_ROOT),
    uploadTempRoot: requiredAbsolutePath(
      'UPLOAD_TEMP_ROOT',
      env.UPLOAD_TEMP_ROOT,
    ),
    uploadMaxBytes: positiveInteger('UPLOAD_MAX_BYTES', env.UPLOAD_MAX_BYTES),
  };
}
