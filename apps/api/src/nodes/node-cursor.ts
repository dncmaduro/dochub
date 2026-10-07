import { BadRequestException } from '@nestjs/common';
import { NodeSortBy, NodeSortDirection } from './node-sort.js';

export interface NodeCursor {
  sortBy: NodeSortBy;
  sortDirection: NodeSortDirection;
  sortValue: string;
  id: string;
}

export function encodeNodeCursor(cursor: NodeCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeNodeCursor(
  value: string | undefined,
  expectedSortBy: NodeSortBy,
  expectedSortDirection: NodeSortDirection,
): NodeCursor | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    const candidate = parsed as Record<string, unknown>;
    const isUuid =
      typeof candidate.id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.id,
      );
    const legacyCursor =
      typeof candidate.normalizedName === 'string' &&
      candidate.normalizedName.length > 0;
    const sortBy = (candidate.sortBy ??
      (legacyCursor ? NodeSortBy.NAME : null)) as NodeSortBy | null;
    const sortDirection = (candidate.sortDirection ??
      (legacyCursor ? NodeSortDirection.ASC : null)) as
      | NodeSortDirection
      | null;
    const sortValue = candidate.sortValue ?? candidate.normalizedName;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !isUuid ||
      !Object.values(NodeSortBy).includes(sortBy as NodeSortBy) ||
      !Object.values(NodeSortDirection).includes(
        sortDirection as NodeSortDirection,
      ) ||
      typeof sortValue !== 'string' ||
      sortValue.length === 0 ||
      (sortBy === NodeSortBy.LAST_MODIFIED &&
        Number.isNaN(Date.parse(sortValue)))
    ) {
      throw new Error('Invalid cursor');
    }
    if (sortBy !== expectedSortBy || sortDirection !== expectedSortDirection) {
      throw new Error('Cursor sort does not match the requested sort');
    }
    return {
      sortBy: sortBy as NodeSortBy,
      sortDirection: sortDirection as NodeSortDirection,
      sortValue: sortValue as string,
      id: candidate.id as string,
    };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
