export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeGroupName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
