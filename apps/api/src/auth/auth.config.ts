export type RefreshCookieSameSite = 'lax' | 'strict' | 'none';

export interface AuthConfig {
  accessTokenSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  refreshTokenLifetimeMs: number;
  refreshCookieName: string;
  refreshCookieSecure: boolean;
  refreshCookieSameSite: RefreshCookieSameSite;
  refreshCookieDomain?: string;
  webOrigin?: string;
}

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 900;
const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 30;
const DEFAULT_REFRESH_COOKIE_NAME = 'dochub_refresh';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function requiredValue(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }

  return normalized;
}

function positiveInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function booleanValue(
  name: string,
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function sameSiteValue(value: string | undefined): RefreshCookieSameSite {
  const normalized = value?.trim().toLowerCase() || 'lax';
  if (
    normalized === 'lax' ||
    normalized === 'strict' ||
    normalized === 'none'
  ) {
    return normalized;
  }

  throw new Error('AUTH_REFRESH_COOKIE_SAME_SITE must be lax, strict, or none');
}

function optionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const refreshTokenTtlDays = positiveInteger(
    'AUTH_REFRESH_TOKEN_TTL_DAYS',
    env.AUTH_REFRESH_TOKEN_TTL_DAYS,
    DEFAULT_REFRESH_TOKEN_TTL_DAYS,
  );
  const refreshTokenLifetimeMs = refreshTokenTtlDays * MILLISECONDS_PER_DAY;
  if (!Number.isSafeInteger(refreshTokenLifetimeMs)) {
    throw new Error('AUTH_REFRESH_TOKEN_TTL_DAYS is too large');
  }

  const refreshCookieSecure = booleanValue(
    'AUTH_REFRESH_COOKIE_SECURE',
    env.AUTH_REFRESH_COOKIE_SECURE,
    false,
  );
  const refreshCookieSameSite = sameSiteValue(
    env.AUTH_REFRESH_COOKIE_SAME_SITE,
  );
  if (refreshCookieSameSite === 'none' && !refreshCookieSecure) {
    throw new Error(
      'AUTH_REFRESH_COOKIE_SAME_SITE=none requires AUTH_REFRESH_COOKIE_SECURE=true',
    );
  }

  return {
    accessTokenSecret: requiredValue(
      'AUTH_ACCESS_TOKEN_SECRET',
      env.AUTH_ACCESS_TOKEN_SECRET,
    ),
    accessTokenTtlSeconds: positiveInteger(
      'AUTH_ACCESS_TOKEN_TTL_SECONDS',
      env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    ),
    refreshTokenTtlDays,
    refreshTokenLifetimeMs,
    refreshCookieName:
      optionalValue(env.AUTH_REFRESH_COOKIE_NAME) ??
      DEFAULT_REFRESH_COOKIE_NAME,
    refreshCookieSecure,
    refreshCookieSameSite,
    refreshCookieDomain: optionalValue(env.AUTH_REFRESH_COOKIE_DOMAIN),
    webOrigin: optionalValue(env.WEB_ORIGIN),
  };
}
