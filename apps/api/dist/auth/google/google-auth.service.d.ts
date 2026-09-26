import { DatabaseService } from '../../database/database.service.js';
import { AuthSessionService } from '../auth-session.service.js';
import type { CreateSessionInput, SessionTokens } from '../auth.types.js';
import { type GoogleOidcClient } from './google-oidc.client.js';
export interface GoogleAuthorizationFlow {
    authorizationUrl: string;
    state: string;
    nonce: string;
    codeVerifier: string;
}
export interface GoogleCallbackInput extends Omit<CreateSessionInput, 'userId'> {
    code: string;
    state: string;
    expectedState: string;
    nonce: string;
    codeVerifier: string;
}
export declare class GoogleAuthService {
    private readonly database;
    private readonly authSessions;
    private readonly oidcClient;
    private readonly logger;
    constructor(database: DatabaseService, authSessions: AuthSessionService, oidcClient: GoogleOidcClient);
    beginAuthorization(): Promise<GoogleAuthorizationFlow>;
    completeAuthorization(input: GoogleCallbackInput): Promise<SessionTokens>;
    private validatedIdentity;
    private resolveOrBindIdentity;
    private resolveOrBindInTransaction;
    private activateIfInvited;
    private isRetriableBindingError;
    private authenticationFailed;
}
