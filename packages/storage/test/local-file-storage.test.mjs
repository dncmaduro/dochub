import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  InvalidStorageKey,
  LocalFileStorage,
  StorageConfigurationError,
  StorageError,
  StorageObjectAlreadyExists,
  StorageObjectNotFound,
} from '../dist/index.js';

async function withStorage(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dochub-storage-test-'));
  try {
    await run(root, new LocalFileStorage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readAll(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test('requires an absolute, non-empty local storage root', () => {
  assert.throws(() => new LocalFileStorage(''), StorageConfigurationError);
  assert.throws(() => new LocalFileStorage('relative/storage'), StorageConfigurationError);
});

test('validates canonical relative POSIX storage keys and contains paths', async () => {
  await withStorage(async (root, storage) => {
    const outside = path.join(path.dirname(root), 'must-not-be-created');
    for (const key of [
      '',
      '/absolute',
      '../secret',
      'foo/../secret',
      'foo/./bar',
      'foo//bar',
      'foo\\bar',
      'nul\0key',
      'file:///secret',
      'C:/secret',
    ]) {
      await assert.rejects(
        storage.putStream(key, Readable.from(['unsafe'])),
        InvalidStorageKey,
      );
    }
    assert.equal(await storage.exists('files/a/versions/b'), false);
    await assert.rejects(lstat(outside));
    await storage.putStream('files/a/versions/b', Readable.from(['safe']));
    assert.equal(
      await readFile(path.join(root, 'files', 'a', 'versions', 'b'), 'utf8'),
      'safe',
    );
  });
});

test('streams nested writes and reads regular objects without a full-object API', async () => {
  await withStorage(async (root, storage) => {
    const key = 'files/a/versions/large';
    async function* chunks() {
      for (let index = 0; index < 64; index += 1) {
        yield Buffer.alloc(64 * 1024, index);
      }
    }
    await storage.putStream(key, Readable.from(chunks()));
    const metadata = await lstat(path.join(root, 'files', 'a', 'versions', 'large'));
    assert.equal(metadata.isFile(), true);
    const read = await readAll(await storage.openReadStream(key));
    assert.equal(read.length, 64 * 64 * 1024);
    assert.equal(read[0], 0);
    assert.equal(read.at(-1), 63);
  });
});

test('does not overwrite immutable objects', async () => {
  await withStorage(async (_root, storage) => {
    const key = 'files/a/versions/v1';
    await storage.putStream(key, Readable.from(['original']));
    await assert.rejects(
      storage.putStream(key, Readable.from(['replacement'])),
      StorageObjectAlreadyExists,
    );
    assert.equal((await readAll(await storage.openReadStream(key))).toString(), 'original');
  });
});

test('cleans up a partial object after a source stream failure', async () => {
  await withStorage(async (_root, storage) => {
    const key = 'files/a/versions/failing';
    let emitted = false;
    const failing = new Readable({
      read() {
        if (!emitted) {
          emitted = true;
          this.push('partial');
          return;
        }
        this.destroy(new Error('source failed'));
      },
    });
    await assert.rejects(storage.putStream(key, failing), StorageError);
    assert.equal(await storage.exists(key), false);
  });
});

test('supports inclusive byte ranges and rejects invalid offsets', async () => {
  await withStorage(async (_root, storage) => {
    const key = 'files/a/versions/range';
    await storage.putStream(key, Readable.from(['0123456789']));
    assert.equal(
      (await readAll(await storage.openReadStream(key, { start: 2, end: 5 }))).toString(),
      '2345',
    );
    await assert.rejects(
      storage.openReadStream(key, { start: -1 }),
      StorageError,
    );
    await assert.rejects(
      storage.openReadStream(key, { start: 5, end: 2 }),
      StorageError,
    );
  });
});

test('returns backend-neutral stats and typed missing-object errors', async () => {
  await withStorage(async (_root, storage) => {
    const key = 'files/a/versions/stat';
    await assert.rejects(storage.stat(key), StorageObjectNotFound);
    await storage.putStream(key, Readable.from(['12345']));
    const metadata = await storage.stat(key);
    assert.equal(metadata.sizeBytes, 5n);
    assert.equal(metadata.modifiedAt instanceof Date, true);
  });
});

test('exists and delete are object-only and delete is idempotent', async () => {
  await withStorage(async (_root, storage) => {
    const key = 'files/a/versions/delete';
    assert.equal(await storage.exists(key), false);
    await storage.putStream(key, Readable.from(['delete me']));
    assert.equal(await storage.exists(key), true);
    await storage.delete(key);
    assert.equal(await storage.exists(key), false);
    await storage.delete(key);
  });
});

test('does not treat final symbolic links as stored objects', async (context) => {
  await withStorage(async (root, storage) => {
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}`);
    const key = 'files/a/versions/symlink';
    const linkPath = path.join(root, 'files', 'a', 'versions', 'symlink');
    try {
      await writeFile(outside, 'outside');
      await storage.putStream('files/a/versions/seed', Readable.from(['seed']));
      try {
        await symlink(outside, linkPath);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          context.skip('symbolic links are not permitted on this platform');
          return;
        }
        throw error;
      }
      await assert.rejects(storage.stat(key), StorageError);
      await assert.rejects(storage.openReadStream(key), StorageError);
      await assert.rejects(storage.delete(key), StorageError);
      assert.equal(await readFile(outside, 'utf8'), 'outside');
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test('does not expose a local path through the storage contract', async () => {
  await withStorage(async (_root, storage) => {
    const key = 'files/a/versions/stream';
    await storage.putStream(key, createReadStream(new URL(import.meta.url)));
    assert.equal(await storage.exists(key), true);
  });
});
