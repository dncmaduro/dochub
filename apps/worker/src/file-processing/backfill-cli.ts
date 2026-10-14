import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FileProcessingModule } from './file-processing.module.js';
import { RevisionFileProcessingService } from './revision-file-processing.service.js';

@Module({ imports: [FileProcessingModule] })
class BackfillModule {}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positive(name: string): number | undefined {
  const value = option(name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

async function main() {
  const app = await NestFactory.createApplicationContext(BackfillModule);
  try {
    const processing = app.get(RevisionFileProcessingService);
    const cursor = option('--cursor');
    const limit = positive('--limit') ?? positive('--batch-size');
    const dryRun = process.argv.includes('--dry-run');
    const result = await processing.enqueueBackfill({
      cursor,
      limit,
      dryRun,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await app.close();
  }
}

await main();
