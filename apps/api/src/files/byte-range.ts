import { HttpException, HttpStatus } from '@nestjs/common';

export interface ByteRange {
  start: number;
  end: number;
}
export class UnsatisfiableRangeError extends HttpException {
  constructor(readonly totalSize: bigint) {
    super('Range Not Satisfiable', HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
  }
}
function unsatisfiable(totalSize: bigint): never {
  throw new UnsatisfiableRangeError(totalSize);
}

/** Parses exactly one RFC 7233 byte range; multiple ranges are deliberately 416. */
export function parseSingleByteRange(
  header: string | undefined,
  totalSize: bigint,
): ByteRange | null {
  if (!header) return null;
  const invalid = () => unsatisfiable(totalSize);
  if (totalSize <= 0n || totalSize > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) invalid();
  const parsed = match!;
  const size = Number(totalSize);
  let start: number;
  let end: number;
  try {
    if (!parsed[1]) {
      const suffix = BigInt(parsed[2]);
      if (suffix > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      if (suffix <= 0n) invalid();
      const length = suffix > totalSize ? size : Number(suffix);
      start = size - length;
      end = size - 1;
    } else {
      const parsedStart = BigInt(parsed[1]);
      if (parsedStart > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      if (parsedStart >= totalSize) invalid();
      start = Number(parsedStart);
      if (parsed[2] && BigInt(parsed[2]) > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      end = parsed[2] ? Math.min(Number(BigInt(parsed[2])), size - 1) : size - 1;
      if (end < start) invalid();
    }
  } catch {
    invalid();
  }
  return { start: start!, end: end! };
}
