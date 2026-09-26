export interface RetentionConfig {
  pollSeconds: number;
  batchSize: number;
  operationConcurrency: number;
}

export function loadRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
): RetentionConfig {
  const pollSeconds = Number(env.TRASH_RETENTION_POLL_SECONDS ?? 60);
  // Node timers overflow beyond this limit and otherwise poll every millisecond.
  if (
    !Number.isFinite(pollSeconds) ||
    pollSeconds <= 0 ||
    pollSeconds * 1000 > 2 ** 31 - 1
  ) {
    throw new Error(
      'TRASH_RETENTION_POLL_SECONDS must be > 0 and fit a Node timer',
    );
  }
  const integer = (name: string, fallback: number, max: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`${name} must be an integer from 1 to ${max}`);
    }
    return value;
  };
  return {
    pollSeconds,
    batchSize: integer('TRASH_RETENTION_BATCH_SIZE', 20, 500),
    operationConcurrency: integer(
      'TRASH_RETENTION_OPERATION_CONCURRENCY',
      1,
      8,
    ),
  };
}
