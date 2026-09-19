import { describe, expect, it } from 'vitest';
import {
  parseSingleByteRange,
  UnsatisfiableRangeError,
} from './byte-range.js';

describe('parseSingleByteRange', () => {
  it('parses bounded, open-ended, suffix, and clamped ranges', () => {
    expect(parseSingleByteRange('bytes=2-5', 10n)).toEqual({ start: 2, end: 5 });
    expect(parseSingleByteRange('bytes=7-', 10n)).toEqual({ start: 7, end: 9 });
    expect(parseSingleByteRange('bytes=-3', 10n)).toEqual({ start: 7, end: 9 });
    expect(parseSingleByteRange('bytes=7-999', 10n)).toEqual({ start: 7, end: 9 });
  });

  it('rejects malformed, multiple, unsafe, and zero-byte ranges', () => {
    for (const header of ['bytes=10-10', 'bytes=7-2', 'bytes=-0', 'bytes=abc-def', 'items=0-1', 'bytes=0-1,4-5', 'bytes=1.2-3', 'bytes=9007199254740992-']) {
      expect(() => parseSingleByteRange(header, 10n)).toThrow(UnsatisfiableRangeError);
    }
    expect(() => parseSingleByteRange('bytes=0-0', 0n)).toThrow(
      UnsatisfiableRangeError,
    );
  });
});
