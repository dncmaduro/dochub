import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { DRIVE_CONFIG, type DriveConfig } from './drive.config.js';

const VERSION = 'v1';
const IV_BYTES = 12;

@Injectable()
export class DriveTokenCryptoService {
  private readonly key?: Buffer;

  constructor(@Inject(DRIVE_CONFIG) config: DriveConfig) {
    this.key = config.tokenEncryptionKey;
  }

  encrypt(value: string): string {
    const key = this.keyOrThrow();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(value: string): string {
    const key = this.keyOrThrow();
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new BadRequestException('Stored Drive credentials are invalid');
    }

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(parts[1], 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3], 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new BadRequestException('Stored Drive credentials are invalid');
    }
  }

  private keyOrThrow(): Buffer {
    if (!this.key) throw new Error('Drive token encryption is not configured');
    return this.key;
  }
}
