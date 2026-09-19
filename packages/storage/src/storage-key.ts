import path from 'node:path';
import { InvalidStorageKey } from './storage.errors.js';

/** Validates canonical, backend-relative POSIX storage keys. */
export function validateStorageKey(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:($|\/)/.test(value) ||
    value.includes('://')
  ) {
    throw new InvalidStorageKey('Invalid storage key');
  }

  const segments = value.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    ) ||
    path.posix.normalize(value) !== value
  ) {
    throw new InvalidStorageKey('Invalid storage key');
  }
  return value;
}
