import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions } from 'express';
import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';

const GOOGLE_FLOW_COOKIE_LIFETIME_MS = 10 * 60 * 1000;

@Injectable()
export class AuthCookieService {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  refreshOptions(includeMaxAge = true): CookieOptions {
    const options = this.baseOptions(
      '/auth',
      this.config.refreshCookieSameSite,
    );
    if (includeMaxAge) {
      options.maxAge = this.config.refreshTokenLifetimeMs;
    }
    return options;
  }

  refreshCookieName(): string {
    return this.config.refreshCookieName;
  }

  googleFlowOptions(): CookieOptions {
    const options = this.baseOptions('/auth/google/callback', 'lax');
    options.maxAge = GOOGLE_FLOW_COOKIE_LIFETIME_MS;
    return options;
  }

  private baseOptions(
    path: string,
    sameSite: CookieOptions['sameSite'],
  ): CookieOptions {
    const options: CookieOptions = {
      httpOnly: true,
      secure: this.config.refreshCookieSecure,
      sameSite,
      path,
    };

    if (this.config.refreshCookieDomain) {
      options.domain = this.config.refreshCookieDomain;
    }
    return options;
  }
}
