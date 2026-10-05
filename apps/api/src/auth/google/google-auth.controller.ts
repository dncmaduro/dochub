import {
  Controller,
  Get,
  Inject,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthCookieService } from '../auth-cookie.service.js';
import { AUTH_CONFIG, type AuthConfig } from '../auth.config.js';
import { GoogleAuthService } from './google-auth.service.js';

const GOOGLE_FLOW_COOKIE_NAMES = {
  state: 'dochub_google_state',
  nonce: 'dochub_google_nonce',
  codeVerifier: 'dochub_google_verifier',
} as const;

@Controller('auth/google')
export class GoogleAuthController {
  constructor(
    private readonly googleAuth: GoogleAuthService,
    private readonly authCookies: AuthCookieService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  @Get()
  async start(@Res() response: Response): Promise<void> {
    const flow = await this.googleAuth.beginAuthorization();
    response.cookie(
      GOOGLE_FLOW_COOKIE_NAMES.state,
      flow.state,
      this.authCookies.googleFlowOptions(),
    );
    response.cookie(
      GOOGLE_FLOW_COOKIE_NAMES.nonce,
      flow.nonce,
      this.authCookies.googleFlowOptions(),
    );
    response.cookie(
      GOOGLE_FLOW_COOKIE_NAMES.codeVerifier,
      flow.codeVerifier,
      this.authCookies.googleFlowOptions(),
    );
    response.redirect(flow.authorizationUrl);
  }

  @Get('callback')
  async callback(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    let flowCookiesCleared = false;
    try {
      const code = this.singleQueryValue(request.query.code);
      const state = this.singleQueryValue(request.query.state);
      const expectedState = this.flowCookie(
        request,
        GOOGLE_FLOW_COOKIE_NAMES.state,
      );
      const nonce = this.flowCookie(request, GOOGLE_FLOW_COOKIE_NAMES.nonce);
      const codeVerifier = this.flowCookie(
        request,
        GOOGLE_FLOW_COOKIE_NAMES.codeVerifier,
      );
      if (!code || !state || !expectedState || !nonce || !codeVerifier) {
        throw this.authenticationFailed();
      }

      const result = await this.googleAuth.completeAuthorization({
        code,
        state,
        expectedState,
        callbackParameters: this.callbackParameters(request),
        nonce,
        codeVerifier,
        ipAddress: request.ip,
        userAgent: request.get('user-agent') ?? undefined,
      });
      this.clearFlowCookies(response);
      flowCookiesCleared = true;
      const googleConfig = this.googleConfig();
      if (result.outcome === 'pending_approval') {
        response.clearCookie(
          this.authCookies.refreshCookieName(),
          this.authCookies.refreshOptions(false),
        );
        response.redirect(
          new URL('/auth/pending', googleConfig.loginSuccessRedirectUrl).toString(),
        );
        return;
      }

      response.cookie(
        this.authCookies.refreshCookieName(),
        result.tokens.refreshToken,
        this.authCookies.refreshOptions(),
      );
      response.redirect(googleConfig.loginSuccessRedirectUrl);
    } finally {
      if (!flowCookiesCleared) {
        this.clearFlowCookies(response);
      }
    }
  }

  private singleQueryValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private flowCookie(request: Request, name: string): string | undefined {
    const value = request.cookies?.[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private callbackParameters(request: Request): URLSearchParams {
    const requestUrl = request.originalUrl ?? request.url;
    const queryStart = requestUrl.indexOf('?');
    const parameters = new URLSearchParams(
      queryStart === -1 ? '' : requestUrl.slice(queryStart + 1),
    );
    const seen = new Set<string>();
    for (const [name] of parameters) {
      // OAuth callback parameters are single-valued. Rejecting duplicates avoids
      // a disagreement between Express query parsing and the OIDC client.
      if (seen.has(name)) throw this.authenticationFailed();
      seen.add(name);
    }
    return parameters;
  }

  private clearFlowCookies(response: Response): void {
    const options = this.authCookies.googleFlowOptions();
    response.clearCookie(GOOGLE_FLOW_COOKIE_NAMES.state, options);
    response.clearCookie(GOOGLE_FLOW_COOKIE_NAMES.nonce, options);
    response.clearCookie(GOOGLE_FLOW_COOKIE_NAMES.codeVerifier, options);
  }

  private googleConfig(): NonNullable<AuthConfig['google']> {
    if (!this.config.google) {
      throw this.authenticationFailed();
    }
    return this.config.google;
  }

  private authenticationFailed(): UnauthorizedException {
    return new UnauthorizedException('Authentication failed');
  }
}
