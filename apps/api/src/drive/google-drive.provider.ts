import { Inject, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { DRIVE_CONFIG, type DriveConfig } from './drive.config.js';

export const DRIVE_PROVIDER = Symbol('DRIVE_PROVIDER');

export const GOOGLE_DRIVE_READONLY_SCOPE =
  'https://www.googleapis.com/auth/drive.readonly';
export const GOOGLE_DRIVE_FILE_SCOPE =
  'https://www.googleapis.com/auth/drive.file';

export interface DriveAuthorizationParameters {
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
}

export interface DriveOAuthCodeParameters {
  code: string;
  codeVerifier: string;
}

export interface DriveOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes?: string[];
}

export interface DriveAccount {
  googleAccountId?: string;
  email?: string;
}

export interface DriveApiFile {
  id: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  modifiedTime?: string;
  createdTime?: string;
  trashed?: boolean;
  parents?: string[];
  driveId?: string;
  sharedWithMeTime?: string;
  ownedByMe?: boolean;
  size?: string;
  version?: string;
  md5Checksum?: string;
  capabilities?: {
    canAddChildren?: boolean;
  };
}

export interface DriveNativeFileCreateRequest {
  name: string;
  mimeType: string;
  parentFolderId: string;
}

export interface DriveBinaryFileCreateRequest {
  name: string;
  mimeType: string;
  parentFolderId: string;
}

export interface DriveFilePage {
  files: DriveApiFile[];
  nextPageToken?: string;
}

export interface DriveContent {
  stream: Readable;
  mimeType: string;
  sizeBytes: bigint | null;
  range: { start: number; end: number; total: number } | null;
}

export interface DriveListOptions {
  pageToken?: string;
  pageSize: number;
  nameQuery?: string;
  includeTrashed: boolean;
  parentFolderId: string;
}

export interface DriveFolderOption {
  id: string;
  name?: string;
  parents?: string[];
}

export interface DriveFolderPage {
  folders: DriveFolderOption[];
  nextPageToken?: string;
}

export interface DriveProvider {
  authorizationUrl(parameters: DriveAuthorizationParameters): string;
  exchangeCode(parameters: DriveOAuthCodeParameters): Promise<DriveOAuthTokens>;
  refreshAccessToken(refreshToken: string): Promise<DriveOAuthTokens>;
  getAccount(accessToken: string): Promise<DriveAccount>;
  listFiles(
    accessToken: string,
    options: DriveListOptions,
  ): Promise<DriveFilePage>;
  listFolders(
    accessToken: string,
    pageToken?: string,
    nameQuery?: string,
  ): Promise<DriveFolderPage>;
  getFile(accessToken: string, driveFileId: string): Promise<DriveApiFile>;
  downloadFile(
    accessToken: string,
    driveFileId: string,
    rangeHeader?: string,
  ): Promise<DriveContent>;
  exportFile(
    accessToken: string,
    driveFileId: string,
    mimeType: string,
  ): Promise<DriveContent>;
  createNativeFile(
    accessToken: string,
    request: DriveNativeFileCreateRequest,
  ): Promise<DriveApiFile>;
  uploadBinaryFile(
    accessToken: string,
    request: DriveBinaryFileCreateRequest,
    source: Readable,
    signal?: AbortSignal,
  ): Promise<DriveApiFile>;
  abortResumableUpload(accessToken: string, sessionUri: string): Promise<void>;
  deleteFile(accessToken: string, driveFileId: string): Promise<void>;
}

export class DriveProviderError extends Error {
  constructor(
    readonly kind:
      'unauthorized' | 'forbidden' | 'rate_limited' | 'provider' | 'network',
    readonly status?: number,
  ) {
    super('Google Drive request failed');
    this.name = 'DriveProviderError';
  }
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_API_ENDPOINT = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3';

const FILE_FIELDS = [
  'id',
  'name',
  'mimeType',
  'webViewLink',
  'modifiedTime',
  'createdTime',
  'trashed',
  'parents',
  'driveId',
  'sharedWithMeTime',
  'ownedByMe',
  'size',
  'version',
  'md5Checksum',
  'capabilities(canAddChildren)',
].join(',');

const RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;

function escapeDriveQuery(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function expiresAt(expiresIn: number): Date {
  return new Date(Date.now() + Math.max(1, expiresIn) * 1000);
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return null;
  return { start, end, total };
}

@Injectable()
export class GoogleDriveApiProvider implements DriveProvider {
  constructor(@Inject(DRIVE_CONFIG) private readonly config: DriveConfig) {}

  authorizationUrl(parameters: DriveAuthorizationParameters): string {
    this.assertEnabled();
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: this.config.clientId!,
      redirect_uri: this.config.redirectUri!,
      response_type: 'code',
      scope: (parameters.scopes ?? [GOOGLE_DRIVE_READONLY_SCOPE]).join(
        ' ',
      ),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: parameters.state,
      code_challenge: parameters.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async exchangeCode(
    parameters: DriveOAuthCodeParameters,
  ): Promise<DriveOAuthTokens> {
    this.assertEnabled();
    const body = await this.postToken({
      code: parameters.code,
      code_verifier: parameters.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: this.config.redirectUri!,
      client_id: this.config.clientId!,
      client_secret: this.config.clientSecret!,
    });
    return this.tokenResponse(body);
  }

  async refreshAccessToken(refreshToken: string): Promise<DriveOAuthTokens> {
    this.assertEnabled();
    const body = await this.postToken({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      client_id: this.config.clientId!,
      client_secret: this.config.clientSecret!,
    });
    return this.tokenResponse(body);
  }

  async getAccount(accessToken: string): Promise<DriveAccount> {
    const body = await this.driveRequest<{
      user?: { permissionId?: string; emailAddress?: string };
    }>('/about', accessToken, { fields: 'user(permissionId,emailAddress)' });
    return {
      googleAccountId: body.user?.permissionId,
      email: body.user?.emailAddress,
    };
  }

  listFiles(
    accessToken: string,
    options: DriveListOptions,
  ): Promise<DriveFilePage> {
    const parameters: Record<string, string> = {
      pageSize: String(options.pageSize),
      spaces: 'drive',
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      orderBy: 'modifiedTime desc,name',
    };
    if (options.pageToken) parameters.pageToken = options.pageToken;
    const clauses = [
      `'${escapeDriveQuery(options.parentFolderId)}' in parents`,
      options.includeTrashed ? '' : 'trashed = false',
      options.nameQuery?.trim()
        ? `name contains '${escapeDriveQuery(options.nameQuery.trim())}'`
        : '',
    ].filter(Boolean);
    if (clauses.length) parameters.q = clauses.join(' and ');

    return this.driveRequest<DriveFilePage>('/files', accessToken, parameters);
  }

  listFolders(
    accessToken: string,
    pageToken?: string,
    nameQuery?: string,
  ): Promise<DriveFolderPage> {
    const parameters: Record<string, string> = {
      pageSize: '100',
      spaces: 'drive',
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      orderBy: 'name',
      q: [
        "mimeType = 'application/vnd.google-apps.folder'",
        'trashed = false',
        nameQuery?.trim()
          ? `name contains '${escapeDriveQuery(nameQuery.trim())}'`
          : '',
      ]
        .filter(Boolean)
        .join(' and '),
    };
    if (pageToken) parameters.pageToken = pageToken;
    return this.driveRequest<DriveFilePage>('/files', accessToken, parameters).then(
      (page) => ({
        folders: page.files.map((file) => ({
          id: file.id,
          name: file.name,
          parents: file.parents,
        })),
        nextPageToken: page.nextPageToken,
      }),
    );
  }

  getFile(accessToken: string, driveFileId: string): Promise<DriveApiFile> {
    return this.driveRequest<DriveApiFile>(
      `/files/${encodeURIComponent(driveFileId)}`,
      accessToken,
      { fields: FILE_FIELDS },
    );
  }

  downloadFile(
    accessToken: string,
    driveFileId: string,
    rangeHeader?: string,
  ): Promise<DriveContent> {
    return this.driveContentRequest(
      `/files/${encodeURIComponent(driveFileId)}`,
      accessToken,
      { alt: 'media' },
      rangeHeader,
    );
  }

  exportFile(
    accessToken: string,
    driveFileId: string,
    mimeType: string,
  ): Promise<DriveContent> {
    return this.driveContentRequest(
      `/files/${encodeURIComponent(driveFileId)}/export`,
      accessToken,
      { mimeType },
    );
  }

  private async postToken(
    parameters: Record<string, string>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(parameters),
      });
    } catch {
      throw new DriveProviderError('network');
    }
    if (!response.ok) throw this.providerError(response.status);
    try {
      return await response.json();
    } catch {
      throw new DriveProviderError('provider', response.status);
    }
  }

  private tokenResponse(value: unknown): DriveOAuthTokens {
    if (!value || typeof value !== 'object')
      throw new DriveProviderError('provider');
    const body = value as Record<string, unknown>;
    if (
      typeof body.access_token !== 'string' ||
      typeof body.expires_in !== 'number'
    ) {
      throw new DriveProviderError('provider');
    }
    return {
      accessToken: body.access_token,
      refreshToken:
        typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      expiresAt: expiresAt(body.expires_in),
      scopes:
        typeof body.scope === 'string'
          ? body.scope.split(/\s+/).filter(Boolean)
          : undefined,
    };
  }

  private async driveRequest<T>(
    path: string,
    accessToken: string,
    parameters: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${DRIVE_API_ENDPOINT}${path}`);
    url.search = new URLSearchParams(parameters).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      throw new DriveProviderError('network');
    }
    if (!response.ok) throw this.providerError(response.status);
    try {
      return (await response.json()) as T;
    } catch {
      throw new DriveProviderError('provider', response.status);
    }
  }

  private async driveContentRequest(
    path: string,
    accessToken: string,
    parameters: Record<string, string>,
    rangeHeader?: string,
  ): Promise<DriveContent> {
    const url = new URL(`${DRIVE_API_ENDPOINT}${path}`);
    url.search = new URLSearchParams(parameters).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(rangeHeader ? { Range: rangeHeader } : {}),
        },
      });
    } catch {
      throw new DriveProviderError('network');
    }
    if (!response.ok) throw this.providerError(response.status);
    if (!response.body) throw new DriveProviderError('provider', response.status);
    const range = parseContentRange(response.headers.get('content-range'));
    const contentLength = Number(response.headers.get('content-length'));
    const sizeBytes = range ? BigInt(range.total) : Number.isSafeInteger(contentLength) ? BigInt(contentLength) : null;
    return {
      stream: Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      mimeType: response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream',
      sizeBytes,
      range,
    };
  }

  async createNativeFile(
    accessToken: string,
    request: DriveNativeFileCreateRequest,
  ): Promise<DriveApiFile> {
    const parameters = {
      fields: FILE_FIELDS,
    };
    const body = {
      name: request.name,
      mimeType: request.mimeType,
      parents: [request.parentFolderId],
    };
    return this.driveMutation<DriveApiFile>(
      '/files',
      accessToken,
      'POST',
      parameters,
      body,
    );
  }

  async uploadBinaryFile(
    accessToken: string,
    request: DriveBinaryFileCreateRequest,
    source: Readable,
    signal?: AbortSignal,
  ): Promise<DriveApiFile> {
    const url = new URL(`${DRIVE_UPLOAD_ENDPOINT}/files`);
    url.search = new URLSearchParams({
      uploadType: 'resumable',
      fields: FILE_FIELDS,
    }).toString();
    const metadata = {
      name: request.name,
      mimeType: request.mimeType,
      parents: [request.parentFolderId],
    };

    let sessionUri: string | undefined;
    try {
      const initiation = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': request.mimeType,
        },
        body: JSON.stringify(metadata),
        signal,
      });
      if (!initiation.ok) throw this.providerError(initiation.status);
      sessionUri = initiation.headers.get('location') ?? undefined;
      if (!sessionUri)
        throw new DriveProviderError('provider', initiation.status);

      let offset = 0;
      let pending: Buffer | null = null;
      let parts: Buffer[] = [];
      let partBytes = 0;

      const receivedOffset = (response: Response): number => {
        const range = response.headers.get('range');
        if (!range) return 0;
        const match = /^bytes=0-(\d+)$/.exec(range);
        if (!match) throw new DriveProviderError('provider', response.status);
        return Number(match[1]) + 1;
      };

      const queryUploadStatus = async (
        total?: number,
      ): Promise<{ offset: number; file?: DriveApiFile }> => {
        let response: Response;
        try {
          response = await fetch(sessionUri!, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Length': '0',
              'Content-Range': `bytes */${total ?? '*'}`,
            },
            body: new Uint8Array(),
            signal,
          });
        } catch {
          throw new DriveProviderError('network');
        }
        if (response.status === 308) {
          return { offset: receivedOffset(response) };
        }
        if (!response.ok) throw this.providerError(response.status);
        try {
          const file = (await response.json()) as DriveApiFile;
          return { offset: Number.POSITIVE_INFINITY, file };
        } catch {
          throw new DriveProviderError('provider', response.status);
        }
      };

      const sendChunk = async (
        bytes: Buffer,
        finalTotal?: number,
      ): Promise<DriveApiFile | undefined> => {
        const start = offset;
        const end = start + bytes.length - 1;
        let cursor = start;
        let noProgressAttempts = 0;
        while (cursor <= end) {
          if (signal?.aborted) throw new DriveProviderError('network');
          const chunk = bytes.subarray(cursor - start);
          let response: Response;
          try {
            response = await fetch(sessionUri!, {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': request.mimeType,
                'Content-Length': String(chunk.length),
                'Content-Range': `bytes ${cursor}-${end}/${finalTotal ?? '*'}`,
              },
              body: new Uint8Array(chunk),
              signal,
            });
          } catch {
            if (signal?.aborted) throw new DriveProviderError('network');
            const status = await queryUploadStatus(finalTotal);
            if (status.file) return status.file;
            if (status.offset < offset || status.offset > end + 1) {
              throw new DriveProviderError('provider');
            }
            if (status.offset === end + 1) {
              offset = status.offset;
              return undefined;
            }
            if (status.offset < cursor) {
              throw new DriveProviderError('provider');
            }
            if (status.offset === cursor && ++noProgressAttempts > 3) {
              throw new DriveProviderError('network');
            }
            cursor = status.offset;
            continue;
          }

          if (response.status === 308) {
            const acceptedOffset = receivedOffset(response);
            if (
              acceptedOffset < offset ||
              acceptedOffset < cursor ||
              acceptedOffset > end + 1
            ) {
              throw new DriveProviderError('provider', response.status);
            }
            if (acceptedOffset === cursor && ++noProgressAttempts > 3) {
              throw new DriveProviderError('network', response.status);
            }
            if (acceptedOffset === end + 1) {
              offset = acceptedOffset;
              return undefined;
            }
            cursor = acceptedOffset;
            continue;
          }

          if (response.status >= 500) {
            const status = await queryUploadStatus(finalTotal);
            if (status.file) return status.file;
            if (status.offset < offset || status.offset > end + 1) {
              throw new DriveProviderError('provider', response.status);
            }
            if (status.offset === end + 1) {
              offset = status.offset;
              return undefined;
            }
            if (status.offset < cursor) {
              throw new DriveProviderError('provider', response.status);
            }
            if (status.offset === cursor && ++noProgressAttempts > 3) {
              throw this.providerError(response.status);
            }
            cursor = status.offset;
            continue;
          }

          if (!response.ok || finalTotal === undefined) {
            throw this.providerError(response.status);
          }
          try {
            const file = (await response.json()) as DriveApiFile;
            offset = end + 1;
            return file;
          } catch {
            throw new DriveProviderError('provider', response.status);
          }
        }
        return undefined;
      };

      for await (const value of source) {
        if (signal?.aborted) throw new DriveProviderError('network');
        let remaining = Buffer.isBuffer(value) ? value : Buffer.from(value);
        while (remaining.length > 0) {
          const take = Math.min(
            RESUMABLE_CHUNK_BYTES - partBytes,
            remaining.length,
          );
          parts.push(remaining.subarray(0, take));
          partBytes += take;
          remaining = remaining.subarray(take);
          if (partBytes === RESUMABLE_CHUNK_BYTES) {
            const fullChunk = Buffer.concat(parts, partBytes);
            parts = [];
            partBytes = 0;
            if (pending) await sendChunk(pending);
            pending = fullChunk;
          }
        }
      }

      if (signal?.aborted) throw new DriveProviderError('network');
      const tail = partBytes ? Buffer.concat(parts, partBytes) : null;
      if (tail) {
        if (pending) await sendChunk(pending);
        pending = tail;
      }
      const finalBytes = pending ?? Buffer.alloc(0);
      const total = offset + finalBytes.length;
      let uploaded = await sendChunk(finalBytes, total);
      if (!uploaded && offset === total) {
        const status = await queryUploadStatus();
        uploaded = status.file;
      }
      if (!uploaded?.id) throw new DriveProviderError('provider');
      return uploaded;
    } catch (error) {
      if (sessionUri) await this.abortResumableUpload(accessToken, sessionUri);
      if (error instanceof DriveProviderError) throw error;
      throw new DriveProviderError('network');
    }
  }

  async abortResumableUpload(
    accessToken: string,
    sessionUri: string,
  ): Promise<void> {
    try {
      await fetch(sessionUri, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      // A resumable URI is sensitive and stays in memory only. The operation
      // that failed is already being reported; abort is best effort.
    }
  }

  async deleteFile(accessToken: string, driveFileId: string): Promise<void> {
    await this.driveMutation<undefined>(
      `/files/${encodeURIComponent(driveFileId)}`,
      accessToken,
      'DELETE',
      {},
    );
  }

  private async driveMutation<T>(
    path: string,
    accessToken: string,
    method: 'POST' | 'DELETE',
    parameters: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`${DRIVE_API_ENDPOINT}${path}`);
    url.search = new URLSearchParams(parameters).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new DriveProviderError('network');
    }
    if (!response.ok) throw this.providerError(response.status);
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new DriveProviderError('provider', response.status);
    }
  }

  private providerError(status: number): DriveProviderError {
    if (status === 401) return new DriveProviderError('unauthorized', status);
    if (status === 403) return new DriveProviderError('forbidden', status);
    if (status === 429) return new DriveProviderError('rate_limited', status);
    return new DriveProviderError('provider', status);
  }

  private assertEnabled(): void {
    if (
      !this.config.enabled ||
      !this.config.clientId ||
      !this.config.clientSecret ||
      !this.config.redirectUri
    ) {
      throw new DriveProviderError('provider');
    }
  }
}
