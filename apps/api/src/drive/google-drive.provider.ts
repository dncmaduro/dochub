import { Inject, Injectable } from '@nestjs/common';
import {
  DRIVE_CONFIG,
  type DriveConfig,
} from './drive.config.js';

export const DRIVE_PROVIDER = Symbol('DRIVE_PROVIDER');

export const GOOGLE_DRIVE_METADATA_READONLY_SCOPE =
  'https://www.googleapis.com/auth/drive.metadata.readonly';
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
}

export interface DriveNativeFileCreateRequest {
  name: string;
  mimeType: string;
  parentFolderId?: string;
}

export interface DriveFilePage {
  files: DriveApiFile[];
  nextPageToken?: string;
}

export interface DriveListOptions {
  pageToken?: string;
  pageSize: number;
  nameQuery?: string;
  includeTrashed: boolean;
  driveId?: string;
}

export interface DriveSharedDrive {
  id: string;
}

export interface DriveSharedDrivePage {
  drives: DriveSharedDrive[];
  nextPageToken?: string;
}

export interface DriveProvider {
  authorizationUrl(parameters: DriveAuthorizationParameters): string;
  exchangeCode(parameters: DriveOAuthCodeParameters): Promise<DriveOAuthTokens>;
  refreshAccessToken(refreshToken: string): Promise<DriveOAuthTokens>;
  getAccount(accessToken: string): Promise<DriveAccount>;
  listFiles(accessToken: string, options: DriveListOptions): Promise<DriveFilePage>;
  listSharedDrives(
    accessToken: string,
    pageToken?: string,
  ): Promise<DriveSharedDrivePage>;
  createNativeFile(
    accessToken: string,
    request: DriveNativeFileCreateRequest,
  ): Promise<DriveApiFile>;
  deleteFile(accessToken: string, driveFileId: string): Promise<void>;
}

export class DriveProviderError extends Error {
  constructor(
    readonly kind:
      | 'unauthorized'
      | 'forbidden'
      | 'rate_limited'
      | 'provider'
      | 'network',
    readonly status?: number,
  ) {
    super('Google Drive request failed');
    this.name = 'DriveProviderError';
  }
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_API_ENDPOINT = 'https://www.googleapis.com/drive/v3';

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
].join(',');

function escapeDriveQuery(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function expiresAt(expiresIn: number): Date {
  return new Date(Date.now() + Math.max(1, expiresIn) * 1000);
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
      scope: (parameters.scopes ?? [GOOGLE_DRIVE_METADATA_READONLY_SCOPE]).join(' '),
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
    const body = await this.driveRequest<{ user?: { permissionId?: string; emailAddress?: string } }>(
      '/about',
      accessToken,
      { fields: 'user(permissionId,emailAddress)' },
    );
    return {
      googleAccountId: body.user?.permissionId,
      email: body.user?.emailAddress,
    };
  }

  listFiles(accessToken: string, options: DriveListOptions): Promise<DriveFilePage> {
    const parameters: Record<string, string> = {
      pageSize: String(options.pageSize),
      spaces: 'drive',
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      orderBy: 'modifiedTime desc,name',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
    };
    if (options.pageToken) parameters.pageToken = options.pageToken;
    if (options.driveId) {
      parameters.corpora = 'drive';
      parameters.driveId = options.driveId;
    } else {
      parameters.corpora = 'user';
    }
    const clauses = [
      options.includeTrashed ? '' : 'trashed = false',
      options.nameQuery?.trim()
        ? `name contains '${escapeDriveQuery(options.nameQuery.trim())}'`
        : '',
    ].filter(Boolean);
    if (clauses.length) parameters.q = clauses.join(' and ');

    return this.driveRequest<DriveFilePage>('/files', accessToken, parameters);
  }

  listSharedDrives(
    accessToken: string,
    pageToken?: string,
  ): Promise<DriveSharedDrivePage> {
    const parameters: Record<string, string> = {
      pageSize: '100',
      fields: 'nextPageToken,drives(id)',
    };
    if (pageToken) parameters.pageToken = pageToken;
    return this.driveRequest<DriveSharedDrivePage>(
      '/drives',
      accessToken,
      parameters,
    );
  }

  private async postToken(parameters: Record<string, string>): Promise<unknown> {
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

  async createNativeFile(
    accessToken: string,
    request: DriveNativeFileCreateRequest,
  ): Promise<DriveApiFile> {
    const parameters = {
      fields: FILE_FIELDS,
      supportsAllDrives: 'true',
    };
    const body = {
      name: request.name,
      mimeType: request.mimeType,
      ...(request.parentFolderId ? { parents: [request.parentFolderId] } : {}),
    };
    return this.driveMutation<DriveApiFile>('/files', accessToken, 'POST', parameters, body);
  }

  async deleteFile(accessToken: string, driveFileId: string): Promise<void> {
    await this.driveMutation<undefined>(
      `/files/${encodeURIComponent(driveFileId)}`,
      accessToken,
      'DELETE',
      { supportsAllDrives: 'true' },
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
