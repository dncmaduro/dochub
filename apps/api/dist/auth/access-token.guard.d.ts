import { CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AuthSessionService } from './auth-session.service.js';
import type { AuthPrincipal } from './auth.types.js';
export interface AuthenticatedRequest extends Request {
    auth?: AuthPrincipal;
}
export declare class AccessTokenGuard implements CanActivate {
    private readonly jwtService;
    private readonly authSessions;
    constructor(jwtService: JwtService, authSessions: AuthSessionService);
    canActivate(context: ExecutionContext): Promise<boolean>;
    authenticateRequest(request: AuthenticatedRequest): Promise<AuthPrincipal>;
    private bearerToken;
    private isAccessTokenPayload;
    private authenticationFailed;
}
