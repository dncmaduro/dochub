import { SystemRole } from '@dochub/database';
import { describe, expect, it } from 'vitest';
import {
  canAdministerAccounts,
  canManageDocuments,
  canViewDocuments,
} from './system-role-policy.js';

describe('system role policy', () => {
  it.each([SystemRole.ADMIN, SystemRole.DOCUMENT_MANAGER, SystemRole.VIEWER])(
    'allows %s to view documents',
    (role) => {
      expect(canViewDocuments(role)).toBe(true);
    },
  );

  it.each([SystemRole.ADMIN, SystemRole.DOCUMENT_MANAGER])(
    'allows %s to manage documents',
    (role) => {
      expect(canManageDocuments(role)).toBe(true);
    },
  );

  it('keeps viewers read-only and reserves account administration for admins', () => {
    expect(canManageDocuments(SystemRole.VIEWER)).toBe(false);
    expect(canAdministerAccounts(SystemRole.ADMIN)).toBe(true);
    expect(canAdministerAccounts(SystemRole.DOCUMENT_MANAGER)).toBe(false);
    expect(canAdministerAccounts(SystemRole.VIEWER)).toBe(false);
  });
});
