import type { SystemRole } from "./api";

export function canViewDocuments(role: SystemRole): boolean {
  return role === "ADMIN" || role === "DOCUMENT_MANAGER" || role === "VIEWER";
}

export function canManageDocuments(role: SystemRole): boolean {
  return role === "ADMIN" || role === "DOCUMENT_MANAGER";
}

export function canAdministerAccounts(role: SystemRole): boolean {
  return role === "ADMIN";
}
