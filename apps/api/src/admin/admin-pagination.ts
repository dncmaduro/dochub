import { BadRequestException } from '@nestjs/common';

export interface CreatedAtCursor {
  createdAt: string;
  id: string;
}

export interface GroupMemberCursor {
  createdAt: string;
  userId: string;
}

export function encodeCursor(
  cursor: CreatedAtCursor | GroupMemberCursor,
): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCreatedAtCursor(
  value: string | undefined,
): CreatedAtCursor | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = decodeCursor(value);
  if (
    typeof parsed.createdAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.createdAt)) ||
    typeof parsed.id !== 'string' ||
    parsed.id.length === 0
  ) {
    throw new BadRequestException('Invalid cursor');
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}

export function decodeGroupMemberCursor(
  value: string | undefined,
): GroupMemberCursor | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = decodeCursor(value);
  if (
    typeof parsed.createdAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.createdAt)) ||
    typeof parsed.userId !== 'string' ||
    parsed.userId.length === 0
  ) {
    throw new BadRequestException('Invalid cursor');
  }
  return { createdAt: parsed.createdAt, userId: parsed.userId };
}

function decodeCursor(value: string): Record<string, unknown> {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
