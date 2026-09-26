import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../database/database.service.js';
import { type AuthConfig } from './auth.config.js';
import type { AuthPrincipal, CreateSessionInput, SessionTokens } from './auth.types.js';
export declare class AuthSessionService {
    private readonly database;
    private readonly jwtService;
    private readonly config;
    constructor(database: DatabaseService, jwtService: JwtService, config: AuthConfig);
    createSession(input: CreateSessionInput): Promise<SessionTokens>;
    refreshSession(refreshToken: string): Promise<SessionTokens>;
    revokeSession(refreshToken: string): Promise<void>;
    validateAccessSession(principal: AuthPrincipal): Promise<AuthPrincipal>;
    private issueTokens;
    private refreshExpiry;
    private assertActiveUser;
    private authenticationFailed;
}
