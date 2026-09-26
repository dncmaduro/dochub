import type { Request, Response } from 'express';
import { AuthCookieService } from '../auth-cookie.service.js';
import { type AuthConfig } from '../auth.config.js';
import { GoogleAuthService } from './google-auth.service.js';
export declare class GoogleAuthController {
    private readonly googleAuth;
    private readonly authCookies;
    private readonly config;
    constructor(googleAuth: GoogleAuthService, authCookies: AuthCookieService, config: AuthConfig);
    start(response: Response): Promise<void>;
    callback(request: Request, response: Response): Promise<void>;
    private singleQueryValue;
    private flowCookie;
    private clearFlowCookies;
    private googleConfig;
    private authenticationFailed;
}
