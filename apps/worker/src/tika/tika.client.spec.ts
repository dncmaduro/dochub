import { Readable } from 'node:stream';
import { TikaClient, TikaClientError } from './tika.client.js';

describe('TikaClient', () => {
  const client = (maxTextBytes = 100) =>
    new TikaClient(new URL('http://tika.example:9998'), 1000, maxTextBytes);

  afterEach(() => vi.unstubAllGlobals());

  it('streams a request and normalizes line endings without altering meaningful text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('Báo cáo\r\ndoanh thu\r\n', { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      client().extractPlainText(Readable.from('source'), 'application/pdf'),
    ).resolves.toBe('Báo cáo\ndoanh thu');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'PUT',
      duplex: 'half',
    });
  });

  it('rejects oversized Tika text without retaining an unbounded response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('x'.repeat(101))),
    );
    await expect(
      client(100).extractPlainText(Readable.from('source'), 'application/pdf'),
    ).rejects.toMatchObject({
      name: TikaClientError.name,
      retryable: false,
    });
  });

  it('classifies network failures as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(
      client().extractPlainText(Readable.from('source'), 'application/pdf'),
    ).rejects.toMatchObject({
      name: TikaClientError.name,
      retryable: true,
    });
  });

  it.each([
    [400, false],
    [429, true],
    [503, true],
  ])('classifies Tika HTTP %i as retryable=%s', async (status, retryable) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status })),
    );
    await expect(
      client().extractPlainText(Readable.from('source'), 'application/pdf'),
    ).rejects.toMatchObject({
      name: TikaClientError.name,
      retryable,
    });
  });

  it('bounds a hung request with a retryable timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      ),
    );
    const timed = new TikaClient(new URL('http://tika.example:9998'), 1, 100);
    await expect(
      timed.extractPlainText(Readable.from('source'), 'application/pdf'),
    ).rejects.toMatchObject({
      name: TikaClientError.name,
      retryable: true,
      message: 'Tika request timed out',
    });
  });
});
