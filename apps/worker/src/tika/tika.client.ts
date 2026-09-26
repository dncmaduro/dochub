import { Readable } from 'node:stream';

export class TikaClientError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TikaClientError';
  }
}

/** Streams a stored binary to Tika and bounds the returned UTF-8 plain text. */
export class TikaClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly timeoutMs: number,
    private readonly maxTextBytes: number,
  ) {}

  async extractPlainText(source: Readable, mimeType: string): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const url = new URL(
        'tika',
        this.baseUrl.href.endsWith('/')
          ? this.baseUrl
          : new URL(`${this.baseUrl.href}/`),
      );
      const response = await fetch(url, {
        method: 'PUT',
        headers: { Accept: 'text/plain', 'Content-Type': mimeType },
        body: Readable.toWeb(source) as BodyInit,
        // Node's fetch requires an explicit streaming duplex mode.
        duplex: 'half',
        signal: abort.signal,
      } as RequestInit & { duplex: 'half' });
      if (!response.ok) {
        throw new TikaClientError(
          `Tika returned HTTP ${response.status}`,
          response.status >= 500,
        );
      }
      if (!response.body) return '';
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxTextBytes) {
          await reader.cancel();
          throw new TikaClientError(
            'Tika response exceeds configured text limit',
            false,
          );
        }
        chunks.push(value);
      }
      return new TextDecoder('utf-8')
        .decode(Buffer.concat(chunks))
        .replace(/\r\n/g, '\n')
        .trim();
    } catch (error) {
      if (error instanceof TikaClientError) throw error;
      const timedOut = abort.signal.aborted;
      throw new TikaClientError(
        timedOut ? 'Tika request timed out' : 'Tika request failed',
        true,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
