import { BadRequestException } from '@nestjs/common';

export interface NodeCursor {
  normalizedName: string;
  id: string;
}

export function encodeNodeCursor(cursor: NodeCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeNodeCursor(
  value: string | undefined,
): NodeCursor | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    const candidate = parsed as Record<string, unknown>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof candidate.normalizedName !== 'string' ||
      typeof candidate.id !== 'string' ||
      candidate.normalizedName.length === 0 ||
      candidate.id.length === 0
    ) {
      throw new Error('Invalid cursor');
    }
    return {
      normalizedName: candidate.normalizedName,
      id: candidate.id,
    };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
