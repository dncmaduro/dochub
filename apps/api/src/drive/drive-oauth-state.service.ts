import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import * as oidc from 'openid-client';
import { AUTH_CONFIG, type AuthConfig } from '../auth/auth.config.js';

const STATE_LIFETIME_MS = 10 * 60 * 1000;

interface DriveOAuthStatePayload {
  userId: string;
  state: string;
  codeVerifier: string;
  expiresAt: number;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

@Injectable()
export class DriveOAuthStateService {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  create(userId: string): {
    state: string;
    codeVerifier: string;
    cookieValue: string;
  } {
    const state = oidc.randomState();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const payload: DriveOAuthStatePayload = {
      userId,
      state,
      codeVerifier,
      expiresAt: Date.now() + STATE_LIFETIME_MS,
    };
    const encoded = encode(JSON.stringify(payload));
    return {
      state,
      codeVerifier,
      cookieValue: `${encoded}.${this.sign(encoded)}`,
    };
  }

  async codeChallenge(codeVerifier: string): Promise<string> {
    return oidc.calculatePKCECodeChallenge(codeVerifier);
  }

  read(cookieValue: string, expectedState: string): DriveOAuthStatePayload {
    const [encoded, signature] = cookieValue.split('.');
    if (!encoded || !signature || !this.validSignature(encoded, signature)) {
      throw this.invalidState();
    }

    try {
      const payload = JSON.parse(decode(encoded)) as Partial<DriveOAuthStatePayload>;
      if (
        typeof payload.userId !== 'string' ||
        typeof payload.state !== 'string' ||
        typeof payload.codeVerifier !== 'string' ||
        typeof payload.expiresAt !== 'number' ||
        payload.state !== expectedState ||
        payload.expiresAt <= Date.now()
      ) {
        throw this.invalidState();
      }
      return payload as DriveOAuthStatePayload;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw this.invalidState();
    }
  }

  private sign(value: string): string {
    return createHmac('sha256', this.config.accessTokenSecret)
      .update(value)
      .digest('base64url');
  }

  private validSignature(value: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(value));
    const actual = Buffer.from(signature);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  private invalidState(): UnauthorizedException {
    return new UnauthorizedException('Drive authorization failed');
  }
}
