export interface AccessTokenPayload {
  sub: string;
  sid: string;
  typ: 'access';
}

export interface AuthPrincipal {
  userId: string;
  sessionId: string;
}

export interface CreateSessionInput {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
