export interface FileMutationReconciliationConfig {
  pollSeconds: number;
  staleSeconds: number;
  batchSize: number;
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadFileMutationReconciliationConfig(): FileMutationReconciliationConfig {
  return {
    pollSeconds: positiveInteger(process.env.FILE_MUTATION_RECONCILIATION_POLL_SECONDS, 60),
    staleSeconds: positiveInteger(process.env.FILE_MUTATION_RECONCILIATION_STALE_SECONDS, 60),
    batchSize: positiveInteger(process.env.FILE_MUTATION_RECONCILIATION_BATCH_SIZE, 25),
  };
}
