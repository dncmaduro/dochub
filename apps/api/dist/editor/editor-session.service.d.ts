import { JwtService } from '@nestjs/jwt';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import { type StorageConfig } from '../storage/storage.config.js';
import { type EditorConfig } from './editor.config.js';
export declare class EditorSessionService {
    private readonly database;
    private readonly authorization;
    private readonly jwt;
    private readonly config;
    private readonly storage;
    constructor(database: DatabaseService, authorization: DocumentAuthorizationService, jwt: JwtService, config: EditorConfig | undefined, storage: StorageConfig);
    static documentKey(versionId: string): string;
    create(actorUserId: string, nodeId: string, mode?: 'VIEW' | 'EDIT'): Promise<{
        session: {
            id: string;
            mode: import("@dochub/database").$Enums.EditorMode;
            status: import("@dochub/database").$Enums.EditorSessionStatus;
            expiresAt: null;
        };
        documentServer: {
            apiUrl: string;
        };
        config: {
            token: string;
        };
    }>;
    close(actorUserId: string, sessionId: string): Promise<{
        id: string;
        status: import("@dochub/database").$Enums.EditorSessionStatus;
        mode: import("@dochub/database").$Enums.EditorMode;
        closedAt: Date | null;
    }>;
    authorizeFetch(requestedSessionId: string, token: string): Promise<{
        nodeId: string;
        versionId: string;
    }>;
    handleCallback(sessionId: string, capabilityToken: string, input: unknown): Promise<{
        error: number;
    }>;
    private callbackPayload;
    private callbackSession;
    private stageEditedDocument;
    private signFetchToken;
    private signCallbackToken;
    private requireConfig;
}
