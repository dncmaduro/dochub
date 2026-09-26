import { BadRequestException } from '@nestjs/common';
export interface SearchCursor {
  tier: number;
  score: number;
  normalizedName: string;
  id: string;
}
export function encodeSearchCursor(value: SearchCursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
export function decodeSearchCursor(value: string): SearchCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<SearchCursor>;
    if (
      !Number.isInteger(parsed.tier) ||
      typeof parsed.score !== 'number' ||
      !Number.isFinite(parsed.score) ||
      !parsed.normalizedName ||
      !parsed.id
    )
      throw new Error();
    return parsed as SearchCursor;
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
