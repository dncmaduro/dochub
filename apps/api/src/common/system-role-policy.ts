import { SystemRole } from '@dochub/database';

/** Account-level Docs Hub capabilities. Account status is checked separately. */
export function canViewDocuments(role: SystemRole): boolean {
  return (
    role === SystemRole.ADMIN ||
    role === SystemRole.DOCUMENT_MANAGER ||
    role === SystemRole.VIEWER
  );
}

export function canManageDocuments(role: SystemRole): boolean {
  return role === SystemRole.ADMIN || role === SystemRole.DOCUMENT_MANAGER;
}

export function canAdministerAccounts(role: SystemRole): boolean {
  return role === SystemRole.ADMIN;
}
