import { BadRequestException, Injectable } from '@nestjs/common';
import { NodeType } from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  type SearchCursor,
} from './search-cursor.js';
import type { SearchQueryDto } from './search.dto.js';

interface SearchRow {
  id: string;
  type: NodeType;
  name: string;
  updatedAt: Date;
  normalizedName: string;
  tier: number;
  score: number;
}
const BATCH_SIZE = 100;
function normalizeSearch(value: string): string {
  return value
    .trim()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

@Injectable()
export class SearchService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
  ) {}
  async search(actorId: string, dto: SearchQueryDto) {
    const query = normalizeSearch(dto.q);
    if (!query) throw new BadRequestException('q must not be blank');
    const limit = dto.limit ?? 20;
    const cursor = dto.cursor ? decodeSearchCursor(dto.cursor) : undefined;
    const items: Array<{
      id: string;
      type: NodeType;
      name: string;
      updatedAt: string;
    }> = [];
    let scanCursor = cursor;
    let lastVisible: SearchRow | undefined;
    while (items.length < limit) {
      const rows = await this.candidates(query, dto.type, scanCursor);
      if (!rows.length) break;
      const capabilityByNode =
        await this.authorization.resolveCapabilitiesForNodes(
          actorId,
          rows.map((row) => row.id),
        );
      for (const row of rows) {
        scanCursor = {
          tier: row.tier,
          score: row.score,
          normalizedName: row.normalizedName,
          id: row.id,
        };
        if (
          !capabilityByNode
            .get(row.id)
            ?.capabilities.has(DocumentCapability.VIEW)
        )
          continue;
        items.push({
          id: row.id,
          type: row.type,
          name: row.name,
          updatedAt: row.updatedAt.toISOString(),
        });
        lastVisible = row;
        if (items.length === limit) break;
      }
      if (rows.length < BATCH_SIZE) break;
    }
    const hasMore = items.length === limit && !!lastVisible;
    return {
      items,
      nextCursor: hasMore
        ? encodeSearchCursor({
            tier: lastVisible!.tier,
            score: lastVisible!.score,
            normalizedName: lastVisible!.normalizedName,
            id: lastVisible!.id,
          })
        : null,
    };
  }
  private candidates(
    query: string,
    type: NodeType | undefined,
    cursor: SearchCursor | undefined,
  ) {
    const pattern = `%${escapeLike(query)}%`;
    return this.database.prisma.$queryRaw<SearchRow[]>`
      WITH ranked AS (
        SELECT "id", "type", "name", "updatedAt", "normalizedName",
          CASE WHEN public.search_unaccent(lower("name")) = ${query} THEN 0
               WHEN public.search_unaccent(lower("name")) LIKE ${`${escapeLike(query)}%`} ESCAPE '\\' THEN 1
               WHEN public.search_unaccent(lower("name")) LIKE ${pattern} ESCAPE '\\' THEN 2 ELSE 3 END AS tier,
          round(similarity(public.search_unaccent(lower("name")), ${query})::numeric, 6)::double precision AS score
        FROM "Node" WHERE "trashOperationId" IS NULL
          AND (${type ?? null}::"NodeType" IS NULL OR "type" = ${type ?? null}::"NodeType")
          AND (public.search_unaccent(lower("name")) LIKE ${pattern} ESCAPE '\\' OR similarity(public.search_unaccent(lower("name")), ${query}) >= 0.25)
      ) SELECT * FROM ranked
      WHERE (${cursor?.tier ?? null}::int IS NULL OR tier > ${cursor?.tier ?? null}
        OR (tier = ${cursor?.tier ?? null} AND score < ${cursor?.score ?? null})
        OR (tier = ${cursor?.tier ?? null} AND score = ${cursor?.score ?? null} AND "normalizedName" > ${cursor?.normalizedName ?? null})
        OR (tier = ${cursor?.tier ?? null} AND score = ${cursor?.score ?? null} AND "normalizedName" = ${cursor?.normalizedName ?? null} AND id > ${cursor?.id ?? null}::uuid))
      ORDER BY tier ASC, score DESC, "normalizedName" ASC, id ASC LIMIT ${BATCH_SIZE}
    `;
  }
}
