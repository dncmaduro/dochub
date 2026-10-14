import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { PrismaClient } from '@dochub/database';
import type { StorageService } from '@dochub/storage';
import { TikaClient } from '../tika/tika.client.js';
import type { FileProcessingConfig } from './file-processing.config.js';
import {
  extractNativeText,
  nativeExtractionSupported,
  NativeExtractionError,
} from './native-text-extractor.js';

type LegacyBackfillOptions = {
  cursor?: string;
  limit: number;
  dryRun?: boolean;
};

type LegacyBackfillResult = {
  examined: number;
  indexed: number;
  failed: number;
  nextCursor: string | null;
  skipped: boolean;
};

/**
 * One-shot compatibility pass for files created before provider revisions.
 *
 * This is deliberately not registered in the worker's normal module: legacy
 * FileVersion/storageKey rows are read only by the explicit backfill command.
 * New writes continue to use FileRevision and RevisionFileProcessingService.
 */
export class LegacyFileBackfillService {
  constructor(
    private readonly database: PrismaClient,
    private readonly storage: StorageService,
    private readonly tika: TikaClient,
    private readonly config: FileProcessingConfig,
  ) {}

  async run(options: LegacyBackfillOptions): Promise<LegacyBackfillResult> {
    const files = await this.database.file.findMany({
      where: {
        backingType: 'LOCAL',
        revisionSequence: 0,
        currentVersionId: { not: null },
        node: { trashOperationId: null },
        ...(options.cursor ? { id: { gt: options.cursor } } : {}),
      },
      select: {
        id: true,
        node: { select: { name: true } },
        currentVersion: {
          select: {
            id: true,
            storageKey: true,
            mimeType: true,
            originalFilename: true,
            sizeBytes: true,
          },
        },
      },
      orderBy: { id: 'asc' },
      take: options.limit,
    });

    let indexed = 0;
    let failed = 0;
    for (const file of files) {
      const version = file.currentVersion;
      const extractionName = version?.mimeType === 'application/octet-stream' && !file.node.name.includes('.')
        ? version.originalFilename
        : file.node.name;
      if (
        !version ||
        !this.canExtract(version.mimeType, extractionName) ||
        options.dryRun
      ) {
        continue;
      }
      const existing = await this.database.searchDocument.findUnique({
        where: { fileId: file.id },
        select: { fileVersionId: true, indexedRevision: true },
      });
      if (existing?.fileVersionId === version.id && existing.indexedRevision === null) continue;
      try {
        const content = await this.extract(version, extractionName);
        if (await this.publish(file.id, version.id, content)) indexed += 1;
      } catch {
        // A single corrupt or missing legacy object must not prevent the rest
        // of the resumable batch from being indexed.
        failed += 1;
        // Keep the command's output stable; detailed diagnostics remain in
        // the worker logs when the normal pipeline handles new revisions.
      }
    }

    return {
      examined: files.length,
      indexed,
      failed,
      nextCursor: files.length === options.limit ? files.at(-1)?.id ?? null : null,
      skipped: false,
    };
  }

  private async extract(
    version: { storageKey: string; mimeType: string; sizeBytes: bigint },
    name: string,
  ): Promise<{ text: string; truncated: boolean }> {
    if (version.sizeBytes > BigInt(this.config.extractionMaxBytes)) {
      throw new NativeExtractionError('LIMIT_EXCEEDED', 'Legacy file exceeds extraction limit');
    }
    const source = await this.storage.openReadStream(version.storageKey);
    if (nativeExtractionSupported(version.mimeType, name)) {
      const bytes = await this.readBounded(source);
      return extractNativeText(
        bytes,
        version.mimeType,
        name,
        this.config.extractionMaxChars,
      );
    }
    const text = await this.tika.extractPlainText(source, version.mimeType);
    return this.boundText(text);
  }

  private async publish(fileId: string, versionId: string, content: { text: string; truncated: boolean }): Promise<boolean> {
    return this.database.$transaction(async (tx) => {
      const current = await tx.file.findUnique({
        where: { id: fileId },
        select: { currentVersionId: true, revisionSequence: true, node: { select: { trashOperationId: true } } },
      });
      if (!current || current.revisionSequence !== 0 || current.currentVersionId !== versionId || current.node.trashOperationId) return false;
      await tx.$executeRaw`
        INSERT INTO "SearchDocument" ("id", "fileId", "fileVersionId", "indexedRevision", "contentText", "searchVector", "indexedAt")
        VALUES (${randomUUID()}::uuid, ${fileId}::uuid, ${versionId}::uuid, NULL, ${content.text}, to_tsvector('simple', public.search_unaccent(${content.text})), NOW())
        ON CONFLICT ("fileId") DO UPDATE SET
          "fileVersionId" = EXCLUDED."fileVersionId",
          "indexedRevision" = NULL,
          "contentText" = EXCLUDED."contentText",
          "searchVector" = EXCLUDED."searchVector",
          "indexedAt" = EXCLUDED."indexedAt"
      `;
      return true;
    });
  }

  private canExtract(mimeType: string, name: string): boolean {
    return (
      nativeExtractionSupported(mimeType, name) ||
      mimeType === 'application/pdf' ||
      name.toLowerCase().endsWith('.pdf') ||
      ['.doc', '.xls', '.ppt'].some((suffix) => name.toLowerCase().endsWith(suffix))
    );
  }

  private async readBounded(source: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > this.config.extractionMaxBytes) {
        source.destroy();
        throw new NativeExtractionError('LIMIT_EXCEEDED', 'Legacy file exceeds extraction limit');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  private boundText(text: string): { text: string; truncated: boolean } {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    return normalized.length <= this.config.extractionMaxChars
      ? { text: normalized, truncated: false }
      : { text: normalized.slice(0, this.config.extractionMaxChars), truncated: true };
  }
}
