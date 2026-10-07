import { describe, expect, it } from 'vitest';
import { DriveTokenCryptoService } from './drive-token-crypto.service.js';

describe('DriveTokenCryptoService', () => {
  it('encrypts token material at rest and decrypts only with the application key', () => {
    const service = new DriveTokenCryptoService({
      tokenEncryptionKey: Buffer.alloc(32, 7),
    } as any);
    const encrypted = service.encrypt('refresh-token-value');
    expect(encrypted).not.toContain('refresh-token-value');
    expect(service.decrypt(encrypted)).toBe('refresh-token-value');

    const otherKey = new DriveTokenCryptoService({
      tokenEncryptionKey: Buffer.alloc(32, 8),
    } as any);
    expect(() => otherKey.decrypt(encrypted)).toThrow();
  });
});
