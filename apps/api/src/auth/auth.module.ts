import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from '../database/database.module.js';
import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';
import { AuthConfigModule } from './auth-config.module.js';
import { AccessTokenGuard } from './access-token.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthSessionService } from './auth-session.service.js';

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
  controllers: [AuthController],
  providers: [AuthSessionService, AccessTokenGuard],
  exports: [AuthSessionService, AccessTokenGuard],
})
export class AuthModule {}
