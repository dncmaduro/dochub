import { createHash } from 'node:crypto';
import type { AuthConfig } from '../auth/auth.config.js';

export interface DriveConfig {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  successRedirectUrl?: string;
  tokenEncryptionKey?: Buffer;
  creationTarget: DriveCreationTarget;
  /** Explicit organization-owned connection used by the legacy migration CLI. */
  migrationOwnerUserId?: string;
}

export type DriveCreationTarget =
  | { type: 'MY_DRIVE'; parentFolderId?: string }
  | { type: 'SHARED_DRIVE'; driveId: string; parentFolderId: string };

export const DRIVE_CONFIG = Symbol('DRIVE_CONFIG');

function optionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function deriveRedirectUri(auth: AuthConfig): string | undefined {
  if (!auth.google) return undefined;
  return auth.google.redirectUri.replace(
    /\/auth\/google\/callback$/,
    '/drive/connection/callback',
  );
}

function defaultSuccessRedirectUrl(auth: AuthConfig): string | undefined {
  if (!auth.google) return undefined;
  const url = new URL(auth.google.loginSuccessRedirectUrl);
  url.pathname = '/profile';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function absoluteHttpUrl(
  name: string,
  value: string,
  production: boolean,
): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    if (production && url.protocol !== 'https:') {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
}

function encryptionKey(value: string | undefined): Buffer | undefined {
  const normalized = optionalValue(value);
  if (!normalized) return undefined;
  if (normalized.length < 32) {
    throw new Error('DRIVE_TOKEN_ENCRYPTION_KEY must be at least 32 characters');
  }
  // Hashing permits operators to use a high-entropy secret without requiring
  // a particular encoding while always producing the AES-256 key size.
  return createHash('sha256').update(normalized, 'utf8').digest();
}

function creationTarget(env: NodeJS.ProcessEnv): DriveCreationTarget {
  const type = optionalValue(env.DRIVE_CREATION_TARGET_TYPE) ?? 'MY_DRIVE';
  const parentFolderId = optionalValue(env.DRIVE_CREATION_PARENT_FOLDER_ID);
  if (type === 'MY_DRIVE') return { type, parentFolderId };
  if (type === 'SHARED_DRIVE') {
    const driveId = optionalValue(env.DRIVE_CREATION_DRIVE_ID);
    if (!driveId || !parentFolderId) {
      throw new Error(
        'DRIVE_CREATION_DRIVE_ID and DRIVE_CREATION_PARENT_FOLDER_ID are required for a Shared Drive target',
      );
    }
    return { type, driveId, parentFolderId };
  }
  throw new Error('DRIVE_CREATION_TARGET_TYPE must be MY_DRIVE or SHARED_DRIVE');
}

export function loadDriveConfig(
  auth: AuthConfig,
  env: NodeJS.ProcessEnv = process.env,
): DriveConfig {
  const rawRedirectUri =
    optionalValue(env.GOOGLE_DRIVE_REDIRECT_URI) ?? deriveRedirectUri(auth);
  const redirectUri = rawRedirectUri
    ? absoluteHttpUrl(
        'GOOGLE_DRIVE_REDIRECT_URI',
        rawRedirectUri,
        env.NODE_ENV === 'production',
      )
    : undefined;
  const configuredKey = encryptionKey(env.DRIVE_TOKEN_ENCRYPTION_KEY);
  const explicitlyConfigured =
    Boolean(env.GOOGLE_DRIVE_REDIRECT_URI?.trim()) ||
    Boolean(env.DRIVE_TOKEN_ENCRYPTION_KEY?.trim());

  if (explicitlyConfigured && !auth.google) {
    throw new Error(
      'Google login credentials must be configured before enabling Google Drive',
    );
  }
  if (explicitlyConfigured && !configuredKey) {
    throw new Error(
      'DRIVE_TOKEN_ENCRYPTION_KEY is required when Google Drive is configured',
    );
  }

  const successRedirectUrl = absoluteHttpUrl(
    'DRIVE_CONNECT_SUCCESS_REDIRECT_URL',
    optionalValue(env.DRIVE_CONNECT_SUCCESS_REDIRECT_URL) ??
      defaultSuccessRedirectUrl(auth) ?? 'http://localhost/profile',
    env.NODE_ENV === 'production',
  );
  if (
    auth.webOrigins.length &&
    !auth.webOrigins.includes(new URL(successRedirectUrl).origin)
  ) {
    throw new Error(
      'DRIVE_CONNECT_SUCCESS_REDIRECT_URL must use an allowed WEB_ORIGIN',
    );
  }

  return {
    enabled: Boolean(auth.google && redirectUri && configuredKey),
    clientId: auth.google?.clientId,
    clientSecret: auth.google?.clientSecret,
    redirectUri,
    successRedirectUrl,
    tokenEncryptionKey: configuredKey,
    creationTarget: creationTarget(env),
    migrationOwnerUserId: optionalValue(env.DRIVE_MIGRATION_OWNER_USER_ID),
  };
}
