import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthProvider, Prisma, UserStatus } from '@dochub/database';
import * as oidc from 'openid-client';
import { DatabaseService } from '../../database/database.service.js';
import { AuthSessionService } from '../auth-session.service.js';
import type { CreateSessionInput, SessionTokens } from '../auth.types.js';
import { normalizeEmail } from '../../common/normalization.js';
import {
  GOOGLE_OIDC_CLIENT,
  type GoogleOidcClient,
} from './google-oidc.client.js';

const MAX_BINDING_ATTEMPTS = 3;

export interface GoogleAuthorizationFlow {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface GoogleCallbackInput extends Omit<
  CreateSessionInput,
  'userId'
> {
  code: string;
  state: string;
  expectedState: string;
  nonce: string;
  codeVerifier: string;
}

interface GoogleIdentity {
  sub: string;
  normalizedEmail: string;
}

interface GoogleClaims {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
}

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly authSessions: AuthSessionService,
    @Inject(GOOGLE_OIDC_CLIENT) private readonly oidcClient: GoogleOidcClient,
  ) {}

  async beginAuthorization(): Promise<GoogleAuthorizationFlow> {
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

    try {
      return {
        authorizationUrl: await this.oidcClient.authorizationUrl({
          state,
          nonce,
          codeChallenge,
        }),
        state,
        nonce,
        codeVerifier,
      };
    } catch {
      this.logger.warn('Google authorization initialization failed');
      throw this.authenticationFailed();
    }
  }

  async completeAuthorization(
    input: GoogleCallbackInput,
  ): Promise<SessionTokens> {
    if (input.state !== input.expectedState) {
      throw this.authenticationFailed();
    }

    try {
      const claims = await this.oidcClient.validateCallback({
        code: input.code,
        state: input.state,
        nonce: input.nonce,
        codeVerifier: input.codeVerifier,
      });
      const identity = this.validatedIdentity(claims);
      const userId = await this.resolveOrBindIdentity(identity);
      return await this.authSessions.createSession({
        userId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.warn('Google authentication failed');
      throw this.authenticationFailed();
    }
  }

  private validatedIdentity(value: unknown): GoogleIdentity {
    if (!value || typeof value !== 'object') {
      throw this.authenticationFailed();
    }

    const claims = value as GoogleClaims;
    if (
      typeof claims.sub !== 'string' ||
      claims.sub.length === 0 ||
      typeof claims.email !== 'string' ||
      claims.email.trim().length === 0 ||
      claims.email_verified !== true
    ) {
      throw this.authenticationFailed();
    }

    return {
      sub: claims.sub,
      normalizedEmail: normalizeEmail(claims.email),
    };
  }

  private async resolveOrBindIdentity(
    identity: GoogleIdentity,
  ): Promise<string> {
    for (let attempt = 0; attempt < MAX_BINDING_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.prisma.$transaction(
          (transaction) =>
            this.resolveOrBindInTransaction(transaction, identity),
          { isolationLevel: 'Serializable' },
        );
      } catch (error) {
        if (
          attempt + 1 < MAX_BINDING_ATTEMPTS &&
          this.isRetriableBindingError(error)
        ) {
          continue;
        }
        throw error;
      }
    }

    throw this.authenticationFailed();
  }

  private async resolveOrBindInTransaction(
    transaction: Prisma.TransactionClient,
    identity: GoogleIdentity,
  ): Promise<string> {
    const existingAccount = await transaction.authAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: AuthProvider.GOOGLE,
          providerAccountId: identity.sub,
        },
      },
      include: { user: { select: { id: true, status: true } } },
    });
    if (existingAccount) {
      return this.activateIfInvited(transaction, existingAccount.user);
    }

    const lockedUsers = await transaction.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User" WHERE "normalizedEmail" = ${identity.normalizedEmail} FOR UPDATE
    `;
    if (lockedUsers.length !== 1) {
      throw this.authenticationFailed();
    }

    const user = await transaction.user.findUnique({
      where: { id: lockedUsers[0].id },
      select: { id: true, status: true },
    });
    if (!user || user.status === UserStatus.SUSPENDED) {
      throw this.authenticationFailed();
    }

    const accountCreatedWhileWaiting = await transaction.authAccount.findUnique(
      {
        where: {
          provider_providerAccountId: {
            provider: AuthProvider.GOOGLE,
            providerAccountId: identity.sub,
          },
        },
        include: { user: { select: { id: true, status: true } } },
      },
    );
    if (accountCreatedWhileWaiting) {
      return this.activateIfInvited(
        transaction,
        accountCreatedWhileWaiting.user,
      );
    }

    const otherGoogleAccount = await transaction.authAccount.findFirst({
      where: { userId: user.id, provider: AuthProvider.GOOGLE },
      select: { id: true },
    });
    if (otherGoogleAccount) {
      throw this.authenticationFailed();
    }

    await transaction.authAccount.create({
      data: {
        userId: user.id,
        provider: AuthProvider.GOOGLE,
        providerAccountId: identity.sub,
      },
    });
    return this.activateIfInvited(transaction, user);
  }

  private async activateIfInvited(
    transaction: Prisma.TransactionClient,
    user: { id: string; status: UserStatus },
  ): Promise<string> {
    if (user.status === UserStatus.SUSPENDED) {
      throw this.authenticationFailed();
    }
    if (user.status === UserStatus.ACTIVE) {
      return user.id;
    }

    const activated = await transaction.user.updateMany({
      where: { id: user.id, status: UserStatus.INVITED },
      data: { status: UserStatus.ACTIVE },
    });
    if (activated.count === 1) {
      return user.id;
    }

    const currentUser = await transaction.user.findUnique({
      where: { id: user.id },
      select: { id: true, status: true },
    });
    if (currentUser?.status === UserStatus.ACTIVE) {
      return currentUser.id;
    }
    throw this.authenticationFailed();
  }

  private isRetriableBindingError(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) {
      return false;
    }
    return error.code === 'P2034' || error.code === 'P2002';
  }

  private authenticationFailed(): UnauthorizedException {
    return new UnauthorizedException('Authentication failed');
  }
}
