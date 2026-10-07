import { afterEach, describe, expect, it, vi } from 'vitest';
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
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
    await expect(provider.refreshAccessToken('refresh-token')).rejects.not.toThrow(
      'secret',
    );
  });

  it('creates a native file with a physical Drive parent and supports Shared Drives', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'drive-doc', mimeType: 'application/vnd.google-apps.document' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
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
    expect(request?.body).toBe(JSON.stringify({
      name: 'Untitled document',
      mimeType: 'application/vnd.google-apps.document',
      parents: ['drive-parent'],
    }));
    const url = fetchMock.mock.calls[0]?.[0];
    expect(String(url)).toContain('supportsAllDrives=true');
  });

  it('deletes a native file for compensation and maps non-success responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const provider = new GoogleDriveApiProvider(config);
    await provider.deleteFile('access-token', 'drive/doc');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/files/drive%2Fdoc');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });
});
