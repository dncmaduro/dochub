import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@dochub/database';
import { DatabaseService } from '../database/database.service.js';
import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';
import type {
  AccessTokenPayload,
  AuthPrincipal,
  CreateSessionInput,
  SessionTokens,
} from './auth.types.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.js';

@Injectable()
export class AuthSessionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly jwtService: JwtService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async createSession(input: CreateSessionInput): Promise<SessionTokens> {
    const user = await this.database.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, status: true },
    });
    this.assertActiveUser(user);

    const refreshToken = generateRefreshToken();
    const session = await this.database.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: hashRefreshToken(refreshToken),
        expiresAt: this.refreshExpiry(),
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      select: { id: true },
    });

    return this.issueTokens(user.id, session.id, refreshToken);
  }

  async refreshSession(refreshToken: string): Promise<SessionTokens> {
    const previousHash = hashRefreshToken(refreshToken);
    const sessions = await this.database.prisma.session.findMany({
      where: { refreshTokenHash: previousHash },
      take: 2,
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
        user: { select: { id: true, status: true } },
      },
    });

    const session = sessions.length === 1 ? sessions[0] : undefined;
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw this.authenticationFailed();
    }
    this.assertActiveUser(session.user);

    const nextRefreshToken = generateRefreshToken();
    const now = new Date();
    const updated = await this.database.prisma.session.updateMany({
      where: {
        id: session.id,
        userId: session.userId,
        refreshTokenHash: previousHash,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        refreshTokenHash: hashRefreshToken(nextRefreshToken),
        lastUsedAt: now,
      },
    });

    if (updated.count !== 1) {
      throw this.authenticationFailed();
    }

    return this.issueTokens(session.userId, session.id, nextRefreshToken);
  }

  async revokeSession(refreshToken: string): Promise<void> {
    const now = new Date();
    await this.database.prisma.session.updateMany({
      where: {
        refreshTokenHash: hashRefreshToken(refreshToken),
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    });
  }

  async validateAccessSession(
    principal: AuthPrincipal,
  ): Promise<AuthPrincipal> {
    const session = await this.database.prisma.session.findUnique({
      where: { id: principal.sessionId },
      select: {
        userId: true,
        expiresAt: true,
        revokedAt: true,
        user: { select: { id: true, status: true } },
      },
    });

    if (
      !session ||
      session.userId !== principal.userId ||
      session.revokedAt ||
      session.expiresAt <= new Date()
    ) {
      throw this.authenticationFailed();
    }
    this.assertActiveUser(session.user);

    return principal;
  }

  private async issueTokens(
    userId: string,
    sessionId: string,
    refreshToken: string,
  ): Promise<SessionTokens> {
    const payload: AccessTokenPayload = {
      sub: userId,
      sid: sessionId,
      typ: 'access',
    };
    return {
      accessToken: await this.jwtService.signAsync(payload),
      refreshToken,
      expiresIn: this.config.accessTokenTtlSeconds,
    };
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.config.refreshTokenLifetimeMs);
  }

  private assertActiveUser(
    user: { id: string; status: UserStatus } | null,
  ): asserts user is {
    id: string;
    status: 'ACTIVE';
  } {
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw this.authenticationFailed();
    }
  }

  private authenticationFailed(): UnauthorizedException {
    return new UnauthorizedException('Authentication failed');
  }
}
