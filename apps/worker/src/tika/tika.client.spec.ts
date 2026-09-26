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
});
