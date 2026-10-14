import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { PrismaClient } from '@dochub/database';

export class RevisionContentReaderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'RevisionContentReaderError';
  }
}

/**
 * Narrow, provider-facing read adapter. Processing code only receives a
 * file descriptor and an opaque saved revision; Google calls are isolated
 * here rather than leaking into extraction or search indexing.
 */
export interface RevisionContentReader {
  openVersion(objectId: string, providerVersionId: string): Promise<Readable>;
}

interface IntegrationCredentials {
  id: string;
  accessTokenEncrypted: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenEncrypted: string | null;
  revokedAt: Date | null;
}

export class GoogleDriveRevisionContentReader implements RevisionContentReader {
  private readonly encryptionKey: Buffer | undefined;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly database: PrismaClient, env = process.env) {
    this.env = env;
    const secret = env.DRIVE_TOKEN_ENCRYPTION_KEY?.trim();
    // Keep the retention/worker process bootable when Drive is not configured;
    // a provider task will receive a terminal configuration error at read time.
    this.encryptionKey = secret ? createHash('sha256').update(secret, 'utf8').digest() : undefined;
  }

  async openVersion(objectId: string, providerVersionId: string): Promise<Readable> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(objectId)}/revisions/${encodeURIComponent(providerVersionId)}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch (error) {
      throw new RevisionContentReaderError('Provider read failed', true, { cause: error });
    }
    if (!response.ok || !response.body) {
      throw new RevisionContentReaderError(
        `Provider revision read returned HTTP ${response.status}`,
        response.status >= 500 || [408, 425, 429].includes(response.status),
      );
    }
    return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  }

  private async accessToken(): Promise<string> {
    const connection = await this.database.googleDriveIntegration.findUnique({
      where: { singletonKey: 'company' },
      select: {
        id: true,
        accessTokenEncrypted: true,
        accessTokenExpiresAt: true,
        refreshTokenEncrypted: true,
        revokedAt: true,
      },
    });
    if (!connection || connection.revokedAt || !connection.refreshTokenEncrypted) {
      throw new RevisionContentReaderError('Google Drive integration is unavailable', false);
    }
    if (connection.accessTokenEncrypted && connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() > Date.now() + 30_000) {
      return this.decrypt(connection.accessTokenEncrypted);
    }
    return this.refresh(connection);
  }

  private async refresh(connection: IntegrationCredentials): Promise<string> {
    const clientId = this.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = this.env.GOOGLE_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret || !connection.refreshTokenEncrypted) {
      throw new RevisionContentReaderError('Google Drive token refresh is not configured', false);
    }
    let response: Response;
    try {
      response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: this.decrypt(connection.refreshTokenEncrypted),
          grant_type: 'refresh_token',
        }),
      });
    } catch (error) {
      throw new RevisionContentReaderError('Google Drive token refresh failed', true, { cause: error });
    }
    if (!response.ok) {
      throw new RevisionContentReaderError('Google Drive token refresh was rejected', response.status >= 500 || response.status === 429);
    }
    const payload = await response.json() as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown };
    if (typeof payload.access_token !== 'string' || !payload.access_token) {
      throw new RevisionContentReaderError('Google Drive token refresh returned no token', false);
    }
    const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
      ? Math.max(1, payload.expires_in)
      : 300;
    await this.database.googleDriveIntegration.update({
      where: { id: connection.id },
      data: {
        accessTokenEncrypted: this.encrypt(payload.access_token),
        accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000),
        ...(typeof payload.refresh_token === 'string' && payload.refresh_token
          ? { refreshTokenEncrypted: this.encrypt(payload.refresh_token) }
          : {}),
      },
    });
    return payload.access_token;
  }

  private decrypt(value: string): string {
    if (!this.encryptionKey) {
      throw new RevisionContentReaderError('Drive token encryption is not configured', false);
    }
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new RevisionContentReaderError('Stored Drive credentials are invalid', false);
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(parts[1], 'base64url'));
      decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
    } catch (error) {
      throw new RevisionContentReaderError('Stored Drive credentials are invalid', false, { cause: error });
    }
  }

  private encrypt(value: string): string {
    if (!this.encryptionKey) {
      throw new RevisionContentReaderError('Drive token encryption is not configured', false);
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }
}
