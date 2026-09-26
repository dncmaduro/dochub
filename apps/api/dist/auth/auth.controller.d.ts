import type { Request, Response } from 'express';
import { AuthCookieService } from './auth-cookie.service.js';
import { AuthSessionService } from './auth-session.service.js';
export declare class AuthController {
    private readonly authSessions;
    private readonly authCookies;
    constructor(authSessions: AuthSessionService, authCookies: AuthCookieService);
    refresh(request: Request, response: Response): Promise<{
        accessToken: string;
        tokenType: 'Bearer';
        expiresIn: number;
    }>;
    logout(request: Request, response: Response): Promise<void>;
    private refreshTokenFrom;
}
