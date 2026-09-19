import { Inject, Injectable } from '@nestjs/common';
import * as oidc from 'openid-client';
import {
  AUTH_CONFIG,
  type AuthConfig,
  type GoogleOidcConfig,
} from '../auth.config.js';

const GOOGLE_ISSUER = new URL('https://accounts.google.com');

export interface GoogleAuthorizationParameters {
  state: string;
  nonce: string;
  codeChallenge: string;
}

export interface GoogleCallbackParameters {
  code: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface GoogleOidcClient {
  authorizationUrl(parameters: GoogleAuthorizationParameters): Promise<string>;
  validateCallback(parameters: GoogleCallbackParameters): Promise<unknown>;
}

export const GOOGLE_OIDC_CLIENT = Symbol('GOOGLE_OIDC_CLIENT');

@Injectable()
export class OpenIdClientGoogleOidcClient implements GoogleOidcClient {
  private configuration?: Promise<oidc.Configuration>;

  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  async authorizationUrl(
    parameters: GoogleAuthorizationParameters,
  ): Promise<string> {
    const google = this.googleConfig();
    const configuration = await this.getConfiguration(google);
    return oidc
      .buildAuthorizationUrl(configuration, {
        response_type: 'code',
        client_id: google.clientId,
        redirect_uri: google.redirectUri,
        scope: 'openid email profile',
        state: parameters.state,
        nonce: parameters.nonce,
        code_challenge: parameters.codeChallenge,
        code_challenge_method: 'S256',
      })
      .toString();
  }

  async validateCallback(
    parameters: GoogleCallbackParameters,
  ): Promise<unknown> {
    const google = this.googleConfig();
    const callbackUrl = new URL(google.redirectUri);
    callbackUrl.searchParams.set('code', parameters.code);
    callbackUrl.searchParams.set('state', parameters.state);

    const tokenResponse = await oidc.authorizationCodeGrant(
      await this.getConfiguration(google),
      callbackUrl,
      {
        expectedState: parameters.state,
        expectedNonce: parameters.nonce,
        pkceCodeVerifier: parameters.codeVerifier,
      },
    );
    return tokenResponse.claims();
  }

  private getConfiguration(
    google: GoogleOidcConfig,
  ): Promise<oidc.Configuration> {
    this.configuration ??= oidc.discovery(
      GOOGLE_ISSUER,
      google.clientId,
      google.clientSecret,
    );
    return this.configuration;
  }

  private googleConfig(): GoogleOidcConfig {
    if (!this.config.google) {
      throw new Error('Google login is not configured');
    }
    return this.config.google;
  }
}
