import { describe, expect, it } from 'vitest';
import { FileSaveOperationStatus } from '@dochub/database';
import { mutationReconciliationEligibility, unrecoverableMutationFinalization } from './file-mutation-reconciliation.service.js';

describe('mutationReconciliationEligibility', () => {
  it('selects only stale provider-written mutations', () => {
    const now = new Date('2026-10-14T10:00:00.000Z');
    expect(mutationReconciliationEligibility(now, 60)).toEqual({
      status: FileSaveOperationStatus.PROVIDER_WRITTEN,
      updatedAt: { lte: new Date('2026-10-14T09:59:00.000Z') },
    });
  });

  it('keeps transient errors reconcilable and flags proven inconsistent records', () => {
    expect(unrecoverableMutationFinalization(new Error('network timeout'))).toBe(false);
    expect(unrecoverableMutationFinalization(new Error('Mutation save-1 has no durable provider result.'))).toBe(true);
  });
});
