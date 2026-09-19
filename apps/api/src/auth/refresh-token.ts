import { createHash, randomBytes } from 'node:crypto';

const REFRESH_TOKEN_BYTES = 48;

export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export function hashRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}
