import 'reflect-metadata';
import { Server } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { type INestApplicationContext } from '@nestjs/common';
import { prisma } from '@dochub/database';
import { LocalFileStorage } from '@dochub/storage';
import { AppModule } from '../src/app.module.js';
import { RetentionService } from '../src/retention/retention.service.js';
import { createRetentionFixture } from './retention-fixture.js';

describe('standalone worker (PostgreSQL e2e)', () => {
  it('boots the real application context, immediately purges a fixture without a listener, and closes cleanly', async () => {
    const fixture = await createRetentionFixture();
    let app: INestApplicationContext | undefined;
    const env = { ...process.env };
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deleting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalDelete = fixture.storage.delete.bind(fixture.storage);
    vi.spyOn(LocalFileStorage.prototype, 'delete').mockImplementation(
      async (key) => {
        entered();
        await gate;
        await originalDelete(key);
      },
    );
    // Keep the real DB/engine, but scope candidate discovery to this fixture.
    const findMany = prisma.trashOperation.findMany.bind(prisma.trashOperation);
    vi.spyOn(prisma.trashOperation, 'findMany').mockImplementation((args) =>
      findMany({
        ...args,
        where: { AND: [args?.where ?? {}, { trashedById: fixture.actorId }] },
      }),
    );
    const listen = vi
      .spyOn(Server.prototype, 'listen')
      .mockImplementation(() => {
        throw new Error('Worker must never open a listener');
      });
    try {
      const doc = await fixture.document();
      process.env.STORAGE_DRIVER = 'local';
      process.env.STORAGE_ROOT = fixture.root;
      process.env.TRASH_RETENTION_POLL_SECONDS = '60';
      app = await NestFactory.createApplicationContext(AppModule, {
        logger: false,
        abortOnError: false,
      });
      const retention = app.get(RetentionService);
      // Bootstrap must return during the first purge so main can enable signals.
      await deleting;
      expect('getHttpServer' in app).toBe(false);
      expect(listen).not.toHaveBeenCalled();
      let closed = false;
      const closing = app.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      expect(await fixture.storage.exists(doc.storageKey)).toBe(true);
      release();
      await closing;
      app = undefined;
      expect(await fixture.storage.exists(doc.storageKey)).toBe(false);
      expect(
        await fixture.database.trashOperation.findUnique({
          where: { id: doc.operation.id },
        }),
      ).toMatchObject({ status: 'PURGED' });
      expect(await retention.runCycle()).toBe(0);
      expect(listen).not.toHaveBeenCalled();
    } finally {
      release();
      await app?.close();
      vi.restoreAllMocks();
      process.env = env;
      await fixture.cleanup();
    }
  });
});
