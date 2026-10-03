export interface FileProcessingConfig {
  pollSeconds: number;
  batchSize: number;
  concurrency: number;
  leaseSeconds: number;
  maxAttempts: number;
  tikaUrl: URL;
  tikaRequestTimeoutSeconds: number;
  tikaMaxTextBytes: number;
}

export function loadFileProcessingConfig(
  env: NodeJS.ProcessEnv = process.env,
): FileProcessingConfig {
  const integer = (name: string, fallback: number, max: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`${name} must be an integer from 1 to ${max}`);
    return value;
  };
  const pollSeconds = integer('FILE_PROCESSING_POLL_SECONDS', 15, 2_147_483);
  let tikaUrl: URL;
  try {
    tikaUrl = new URL(env.TIKA_URL ?? 'http://localhost:9998');
  } catch {
    throw new Error('TIKA_URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(tikaUrl.protocol))
    throw new Error('TIKA_URL must be an absolute HTTP(S) URL');
  const tikaRequestTimeoutSeconds = integer(
    'TIKA_REQUEST_TIMEOUT_SECONDS',
    60,
    600,
  );
  const leaseSeconds = integer('FILE_PROCESSING_LEASE_SECONDS', 300, 3600);
  // Tika is the only potentially long-running operation and is deadline-bound.
  // Keep a margin so a valid worker cannot lose ownership while its request is
  // still within the configured deadline.
  if (leaseSeconds <= tikaRequestTimeoutSeconds + 30)
    throw new Error(
      'FILE_PROCESSING_LEASE_SECONDS must exceed TIKA_REQUEST_TIMEOUT_SECONDS by at least 30 seconds',
    );
  return {
    pollSeconds,
    batchSize: integer('FILE_PROCESSING_BATCH_SIZE', 20, 500),
    concurrency: integer('FILE_PROCESSING_CONCURRENCY', 2, 8),
    leaseSeconds,
    maxAttempts: integer('FILE_PROCESSING_MAX_ATTEMPTS', 5, 20),
    tikaUrl,
    tikaRequestTimeoutSeconds,
    tikaMaxTextBytes: integer(
      'TIKA_MAX_TEXT_BYTES',
      16 * 1024 * 1024,
      32 * 1024 * 1024,
    ),
  };
}
