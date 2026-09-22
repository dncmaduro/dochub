export const TRASH_CONFIG = Symbol('TRASH_CONFIG');
export interface TrashConfig { retentionDays: number }
export function loadTrashConfig(env: NodeJS.ProcessEnv = process.env): TrashConfig {
  const value = env.TRASH_RETENTION_DAYS ?? '30';
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error('TRASH_RETENTION_DAYS must be a positive integer');
  }
  return { retentionDays: Number(value) };
}
