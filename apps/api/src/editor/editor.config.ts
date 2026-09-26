export interface EditorConfig {
  publicUrl: URL;
  internalApiUrl: URL;
  jwtSecret: string;
  fetchTokenSecret: string;
  fetchTokenTtlSeconds: number;
  callbackTokenTtlSeconds: number;
}

export const EDITOR_CONFIG = Symbol('EDITOR_CONFIG');

function value(name: string, input: string | undefined): string {
  const result = input?.trim();
  if (!result)
    throw new Error(`${name} is required when ONLYOFFICE is configured`);
  return result;
}

function httpUrl(name: string, input: string): URL {
  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error();
    return url;
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
}

/** Undefined deliberately leaves unrelated API features available without ONLYOFFICE. */
export function loadEditorConfig(
  env: NodeJS.ProcessEnv = process.env,
): EditorConfig | undefined {
  const fields = [
    env.ONLYOFFICE_PUBLIC_URL,
    env.ONLYOFFICE_INTERNAL_API_URL,
    env.ONLYOFFICE_JWT_SECRET,
    env.ONLYOFFICE_FETCH_TOKEN_SECRET,
  ];
  if (fields.every((field) => !field?.trim())) return undefined;
  const jwtSecret = value('ONLYOFFICE_JWT_SECRET', env.ONLYOFFICE_JWT_SECRET);
  const fetchTokenSecret = value(
    'ONLYOFFICE_FETCH_TOKEN_SECRET',
    env.ONLYOFFICE_FETCH_TOKEN_SECRET,
  );
  if (jwtSecret.length < 32 || fetchTokenSecret.length < 32)
    throw new Error('ONLYOFFICE secrets must be at least 32 characters');
  const rawTtl = env.ONLYOFFICE_FETCH_TOKEN_TTL_SECONDS?.trim() || '900';
  if (!/^\d+$/.test(rawTtl))
    throw new Error(
      'ONLYOFFICE_FETCH_TOKEN_TTL_SECONDS must be a positive integer',
    );
  const fetchTokenTtlSeconds = Number(rawTtl);
  if (
    !Number.isSafeInteger(fetchTokenTtlSeconds) ||
    fetchTokenTtlSeconds < 60 ||
    fetchTokenTtlSeconds > 3600
  )
    throw new Error(
      'ONLYOFFICE_FETCH_TOKEN_TTL_SECONDS must be between 60 and 3600',
    );
  // Callback capabilities deliberately use the separate callback audience and
  // purpose below. Reusing the already independent fetch secret avoids a new
  // deployment secret while preserving cryptographic domain separation.
  const rawCallbackTtl =
    env.ONLYOFFICE_CALLBACK_TOKEN_TTL_SECONDS?.trim() || '3600';
  if (!/^\d+$/.test(rawCallbackTtl))
    throw new Error(
      'ONLYOFFICE_CALLBACK_TOKEN_TTL_SECONDS must be a positive integer',
    );
  const callbackTokenTtlSeconds = Number(rawCallbackTtl);
  if (
    !Number.isSafeInteger(callbackTokenTtlSeconds) ||
    callbackTokenTtlSeconds < 60 ||
    callbackTokenTtlSeconds > 86400
  )
    throw new Error(
      'ONLYOFFICE_CALLBACK_TOKEN_TTL_SECONDS must be between 60 and 86400',
    );
  return {
    publicUrl: httpUrl(
      'ONLYOFFICE_PUBLIC_URL',
      value('ONLYOFFICE_PUBLIC_URL', env.ONLYOFFICE_PUBLIC_URL),
    ),
    internalApiUrl: httpUrl(
      'ONLYOFFICE_INTERNAL_API_URL',
      value('ONLYOFFICE_INTERNAL_API_URL', env.ONLYOFFICE_INTERNAL_API_URL),
    ),
    jwtSecret,
    fetchTokenSecret,
    fetchTokenTtlSeconds,
    callbackTokenTtlSeconds,
  };
}
