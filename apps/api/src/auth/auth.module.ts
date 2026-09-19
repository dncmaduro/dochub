import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../database/database.module.js';
import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';
import { AuthConfigModule } from './auth-config.module.js';
import { AuthCookieService } from './auth-cookie.service.js';
import { AccessTokenGuard } from './access-token.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthSessionService } from './auth-session.service.js';
import { GoogleAuthController } from './google/google-auth.controller.js';
import { GoogleAuthService } from './google/google-auth.service.js';
import {
  GOOGLE_OIDC_CLIENT,
  OpenIdClientGoogleOidcClient,
} from './google/google-oidc.client.js';

@Module({
  imports: [
    DatabaseModule,
    AuthConfigModule,
    JwtModule.registerAsync({
      imports: [AuthConfigModule],
      inject: [AUTH_CONFIG],
      useFactory: (config: AuthConfig) => ({
        secret: config.accessTokenSecret,
        signOptions: { expiresIn: config.accessTokenTtlSeconds },
      }),
    }),
  ],
  controllers: [AuthController, GoogleAuthController],
  providers: [
    AuthCookieService,
    AuthSessionService,
    AccessTokenGuard,
    GoogleAuthService,
    {
      provide: GOOGLE_OIDC_CLIENT,
      useExisting: OpenIdClientGoogleOidcClient,
    },
    OpenIdClientGoogleOidcClient,
  ],
  exports: [JwtModule, AuthSessionService, AccessTokenGuard],
})
export class AuthModule {}
