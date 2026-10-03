export interface RuntimeSecurityConfig {
  production: boolean;
  trustProxyHops: number;
  jsonBodyLimitBytes: number;
}

function boundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const raw = value?.trim() || String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum)
    throw new Error(`${name} must be between 0 and ${maximum}`);
  return parsed;
}

/** Settings consumed before the HTTP server starts accepting requests. */
export function loadRuntimeSecurityConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSecurityConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  try {
    const url = new URL(databaseUrl);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
      throw new Error();
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  return {
    production: env.NODE_ENV === 'production',
    // 0 is the safe default. Set this only to the number of controlled reverse
    // proxies directly in front of the API; never trust forwarded headers from
    // an internet-facing Node process.
    trustProxyHops: boundedInteger(
      'TRUST_PROXY_HOPS',
      env.TRUST_PROXY_HOPS,
      0,
      2,
    ),
    jsonBodyLimitBytes: boundedInteger(
      'API_JSON_BODY_LIMIT_BYTES',
      env.API_JSON_BODY_LIMIT_BYTES,
      1024 * 1024,
      10 * 1024 * 1024,
    ),
  };
}
