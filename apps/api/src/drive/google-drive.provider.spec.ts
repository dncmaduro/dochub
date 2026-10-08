import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
  DriveProviderError,
  GoogleDriveApiProvider,
} from './google-drive.provider.js';

const config = {
  enabled: true,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://app.example.test/drive/connection/callback',
  tokenEncryptionKey: Buffer.alloc(32),
  creationTarget: { type: 'MY_DRIVE' as const },
};

afterEach(() => vi.restoreAllMocks());

describe('GoogleDriveApiProvider', () => {
  it('uses the metadata-only scope and PKCE authorization parameters', () => {
    const provider = new GoogleDriveApiProvider(config);
    const url = new URL(
      provider.authorizationUrl({ state: 'state', codeChallenge: 'challenge' }),
    );
    expect(url.searchParams.get('scope')).toBe(
      GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
    );
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  it('adds only the drive.file scope for explicit write authorization', () => {
    const provider = new GoogleDriveApiProvider(config);
    const url = new URL(
      provider.authorizationUrl({
        state: 'state',
        codeChallenge: 'challenge',
        scopes: [GOOGLE_DRIVE_METADATA_READONLY_SCOPE, GOOGLE_DRIVE_FILE_SCOPE],
      }),
    );
    expect(url.searchParams.get('scope')).toBe(
      `${GOOGLE_DRIVE_METADATA_READONLY_SCOPE} ${GOOGLE_DRIVE_FILE_SCOPE}`,
    );
  });

  it('passes Drive pagination and search through the API boundary', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ nextPageToken: 'next', files: [{ id: 'drive-1' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    const provider = new GoogleDriveApiProvider(config);
    const page = await provider.listFiles('access-token', {
      pageToken: 'previous',
      pageSize: 25,
      nameQuery: "O'Reilly",
      includeTrashed: false,
    });
    const request = fetchMock.mock.calls[0]?.[0];
    const requestUrl =
      typeof request === 'string'
        ? request
        : request instanceof URL
          ? request.toString()
          : request instanceof Request
            ? request.url
            : '';
    const url = new URL(requestUrl);
    expect(url.searchParams.get('pageToken')).toBe('previous');
    expect(url.searchParams.get('pageSize')).toBe('25');
    expect(url.searchParams.get('q')).toContain("name contains 'O\\'Reilly'");
    expect(page.nextPageToken).toBe('next');
  });

  it('normalizes provider authorization failures without exposing response bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('token=secret', { status: 401 }),
    );
    const provider = new GoogleDriveApiProvider(config);
    await expect(provider.refreshAccessToken('refresh-token')).rejects.toEqual(
      expect.objectContaining<Partial<DriveProviderError>>({
        kind: 'unauthorized',
        status: 401,
      }),
    );
    await expect(
      provider.refreshAccessToken('refresh-token'),
    ).rejects.not.toThrow('secret');
  });

  it('creates a native file with a physical Drive parent and supports Shared Drives', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'drive-doc',
          mimeType: 'application/vnd.google-apps.document',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const provider = new GoogleDriveApiProvider(config);
    const file = await provider.createNativeFile('access-token', {
      name: 'Untitled document',
      mimeType: 'application/vnd.google-apps.document',
      parentFolderId: 'drive-parent',
    });
    expect(file.id).toBe('drive-doc');
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.method).toBe('POST');
    expect(request?.body).toBe(
      JSON.stringify({
        name: 'Untitled document',
        mimeType: 'application/vnd.google-apps.document',
        parents: ['drive-parent'],
      }),
    );
    const url = fetchMock.mock.calls[0]?.[0];
    expect(String(url)).toContain('supportsAllDrives=true');
  });

  it('streams a binary file through a Drive resumable session at the configured parent', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push({ url, init });
        if (init?.method === 'POST') {
          return new Response(null, {
            status: 200,
            headers: { location: 'https://upload.example.test/session/secret' },
          });
        }
        return new Response(
          JSON.stringify({
            id: 'uploaded-pdf',
            name: 'report.pdf',
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/uploaded-pdf/view',
            parents: ['physical-target'],
            size: '13',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
    const provider = new GoogleDriveApiProvider(config);
    const file = await provider.uploadBinaryFile(
      'server-access-token',
      {
        name: 'report.pdf',
        mimeType: 'application/pdf',
        parentFolderId: 'physical-target',
      },
      Readable.from([Buffer.from('%PDF-1.7 test')]),
    );

    expect(file.id).toBe('uploaded-pdf');
    expect(calls).toHaveLength(2);
    const initiation = calls[0]!;
    expect(initiation.url).toMatch(
      /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/,
    );
    expect(initiation.url).toContain('uploadType=resumable');
    expect(initiation.init?.headers).toMatchObject({
      Authorization: 'Bearer server-access-token',
      'X-Upload-Content-Type': 'application/pdf',
    });
    expect(initiation.init?.body).toBe(
      JSON.stringify({
        name: 'report.pdf',
        mimeType: 'application/pdf',
        parents: ['physical-target'],
      }),
    );
    const upload = calls[1]!;
    expect(upload.init?.method).toBe('PUT');
    expect(upload.init?.headers).toMatchObject({
      'Content-Range': 'bytes 0-12/13',
      'Content-Type': 'application/pdf',
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('drive.googleapis.com'),
      expect.objectContaining({ body: '%PDF-1.7 test' }),
    );
  });

  it('sends production-sized data in bounded, aligned chunks', async () => {
    const chunkSize = 8 * 1024 * 1024;
    const calls: RequestInit[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      calls.push(init ?? {});
      if (init?.method === 'POST') {
        return new Response(null, {
          status: 200,
          headers: { location: 'https://upload.example.test/session/chunks' },
        });
      }
      if (
        init?.headers &&
        (init.headers as Record<string, string>)['Content-Range']?.endsWith(
          '/*',
        )
      ) {
        return new Response(null, {
          status: 308,
          headers: { range: `bytes=0-${chunkSize - 1}` },
        });
      }
      return new Response(JSON.stringify({ id: 'chunked-file' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const provider = new GoogleDriveApiProvider(config);
    const bytes = Buffer.alloc(chunkSize + 3, 0x61);
    await provider.uploadBinaryFile(
      'access-token',
      { name: 'large.bin', mimeType: 'application/octet-stream' },
      Readable.from([bytes]),
    );

    expect(calls).toHaveLength(3);
    expect(calls[1]?.headers).toMatchObject({
      'Content-Length': String(chunkSize),
      'Content-Range': `bytes 0-${chunkSize - 1}/*`,
    });
    expect(calls[2]?.headers).toMatchObject({
      'Content-Length': '3',
      'Content-Range': `bytes ${chunkSize}-${chunkSize + 2}/${chunkSize + 3}`,
    });
  });

  it('resumes a partially acknowledged chunk from Drive’s accepted range', async () => {
    const chunkSize = 8 * 1024 * 1024;
    const half = chunkSize / 2;
    const ranges: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') {
        return new Response(null, {
          status: 200,
          headers: { location: 'https://upload.example.test/session/partial' },
        });
      }
      const headers = init?.headers as Record<string, string>;
      const range = headers['Content-Range']!;
      ranges.push(range);
      if (range.endsWith('/*')) {
        return new Response(null, {
          status: 308,
          headers: {
            range: range.startsWith('bytes 0-')
              ? `bytes=0-${half - 1}`
              : `bytes=0-${chunkSize - 1}`,
          },
        });
      }
      return new Response(JSON.stringify({ id: 'partial-file' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const provider = new GoogleDriveApiProvider(config);
    await provider.uploadBinaryFile(
      'access-token',
      { name: 'large.bin', mimeType: 'application/octet-stream' },
      Readable.from([Buffer.alloc(chunkSize + 1, 0x61)]),
    );

    expect(ranges).toEqual([
      `bytes 0-${chunkSize - 1}/*`,
      `bytes ${half}-${chunkSize - 1}/*`,
      `bytes ${chunkSize}-${chunkSize}/${chunkSize + 1}`,
    ]);
  });

  it('aborts an incomplete resumable session when an upstream chunk fails', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, method: init?.method });
      if (init?.method === 'POST') {
        return new Response(null, {
          status: 200,
          headers: { location: 'https://upload.example.test/session/failing' },
        });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('provider details', { status: 503 });
    });
    const provider = new GoogleDriveApiProvider(config);
    await expect(
      provider.uploadBinaryFile(
        'access-token',
        { name: 'report.pdf', mimeType: 'application/pdf' },
        Readable.from([Buffer.from('%PDF-1.7 test')]),
      ),
    ).rejects.toMatchObject({ kind: 'provider', status: 503 });
    expect(calls.at(-1)).toEqual({
      url: 'https://upload.example.test/session/failing',
      method: 'DELETE',
    });
  });

  it('deletes a native file for compensation and maps non-success responses', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const provider = new GoogleDriveApiProvider(config);
    await provider.deleteFile('access-token', 'drive/doc');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/files/drive%2Fdoc',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });
});
