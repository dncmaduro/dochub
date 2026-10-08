import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import {
  DriveFileMigrationService,
  type DriveMigrationFilters,
} from './drive-file-migration.service.js';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function filters(args: string[]): DriveMigrationFilters {
  const limitValue = option(args, '--limit');
  const limit = limitValue ? Number(limitValue) : undefined;
  if (limitValue && (!Number.isSafeInteger(limit) || limit! <= 0)) {
    throw new Error('--limit must be a positive integer');
  }
  return {
    fileId: option(args, '--file-id'),
    after: option(args, '--after'),
    limit,
    failedOnly: args.includes('--failed-only'),
  };
}

function print(value: unknown): void {
  process.stdout.write(
    `${JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2)}\n`,
  );
}

function report(
  operation: string,
  filters: DriveMigrationFilters,
  result: unknown,
): void {
  print({
    environment: process.env.NODE_ENV ?? 'development',
    operation,
    filters,
    result,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const first = args[0];
  const command =
    first && !first.startsWith('--') ? first : dryRun ? 'inventory' : 'status';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const service = app.get(DriveFileMigrationService);
    const selected = filters(args);
    if (command === 'inventory' || command === 'dry-run' || dryRun) {
      report('inventory', selected, await service.inventory(selected));
      return;
    }
    if (command === 'status') {
      report('status', selected, await service.status());
      return;
    }
    if (command === 'migrate') {
      report('migrate', selected, await service.migrate(selected));
      return;
    }
    if (command === 'rollback') {
      const fileId = option(args, '--file-id');
      if (!fileId) throw new Error('rollback requires --file-id');
      report(
        'rollback',
        { ...selected, fileId },
        {
          fileId,
          status: await service.rollback(fileId),
        },
      );
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Migration command failed'}\n`,
  );
  process.exitCode = 1;
});
