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
  webOrigins: string[];
  google?: GoogleOidcConfig;
}

export interface GoogleOidcConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  loginSuccessRedirectUrl: string;
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

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production';
}

function strongSecret(
  name: string,
  value: string,
  production: boolean,
): string {
  if (!production) return value;
  if (
    value.length < 32 ||
    /^(?:replace|change|test|dev|secret|password)/i.test(value) ||
    /^(.)\1+$/.test(value)
  ) {
    throw new Error(
      `${name} must be a non-placeholder, high-entropy secret of at least 32 characters in production`,
    );
  }
  return value;
}

function absoluteHttpUrl(name: string, value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error();
    }
    return value;
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
}

function webOrigins(env: NodeJS.ProcessEnv): string[] {
  const raw = optionalValue(env.WEB_ORIGIN);
  if (!raw) {
    if (isProduction(env))
      throw new Error('WEB_ORIGIN is required in production');
    return [];
  }
  const origins = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!origins.length)
    throw new Error('WEB_ORIGIN must contain at least one origin');
  const normalized = origins.map((value) => {
    const url = new URL(absoluteHttpUrl('WEB_ORIGIN', value));
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error(
        'WEB_ORIGIN must contain only origins, without paths or credentials',
      );
    if (isProduction(env) && url.protocol !== 'https:')
      throw new Error('WEB_ORIGIN must use https in production');
    return url.origin;
  });
  if (new Set(normalized).size !== normalized.length)
    throw new Error('WEB_ORIGIN must not contain duplicate origins');
  return normalized;
}

function googleOidcConfig(
  env: NodeJS.ProcessEnv,
): GoogleOidcConfig | undefined {
  const values = {
    clientId: optionalValue(env.GOOGLE_CLIENT_ID),
    clientSecret: optionalValue(env.GOOGLE_CLIENT_SECRET),
    redirectUri: optionalValue(env.GOOGLE_REDIRECT_URI),
    loginSuccessRedirectUrl: optionalValue(env.AUTH_LOGIN_SUCCESS_REDIRECT_URL),
  };
  const configuredValues = Object.values(values).filter(Boolean);

  if (configuredValues.length === 0) {
    return undefined;
  }
  if (configuredValues.length !== Object.keys(values).length) {
    throw new Error(
      'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, and AUTH_LOGIN_SUCCESS_REDIRECT_URL must be configured together',
    );
  }

  return {
    clientId: values.clientId!,
    clientSecret: values.clientSecret!,
    redirectUri: absoluteHttpUrl('GOOGLE_REDIRECT_URI', values.redirectUri!),
    loginSuccessRedirectUrl: absoluteHttpUrl(
      'AUTH_LOGIN_SUCCESS_REDIRECT_URL',
      values.loginSuccessRedirectUrl!,
    ),
  };
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

  const production = isProduction(env);
  if (production && !refreshCookieSecure) {
    throw new Error('AUTH_REFRESH_COOKIE_SECURE must be true in production');
  }
  const origins = webOrigins(env);
  const google = googleOidcConfig(env);
  if (production && !google) {
    throw new Error('Google OIDC must be configured in production');
  }
  if (
    google &&
    (!origins.includes(new URL(google.loginSuccessRedirectUrl).origin) ||
      (production &&
        (new URL(google.redirectUri).protocol !== 'https:' ||
          new URL(google.loginSuccessRedirectUrl).protocol !== 'https:')))
  ) {
    throw new Error(
      'AUTH_LOGIN_SUCCESS_REDIRECT_URL must use an allowed WEB_ORIGIN and Google OIDC URLs must use https in production',
    );
  }

  return {
    accessTokenSecret: strongSecret(
      'AUTH_ACCESS_TOKEN_SECRET',
      requiredValue('AUTH_ACCESS_TOKEN_SECRET', env.AUTH_ACCESS_TOKEN_SECRET),
      production,
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
    webOrigins: origins,
    google,
  };
}
