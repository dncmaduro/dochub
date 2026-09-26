import { JwtService } from '@nestjs/jwt';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import { type EditorConfig } from './editor.config.js';
export declare class EditorSessionService {
    private readonly database;
    private readonly authorization;
    private readonly jwt;
    private readonly config;
    constructor(database: DatabaseService, authorization: DocumentAuthorizationService, jwt: JwtService, config: EditorConfig | undefined);
    static documentKey(versionId: string): string;
    create(actorUserId: string, nodeId: string): Promise<{
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
            documentType: "word" | "cell" | "slide";
            document: {
                fileType: string;
                key: string;
                title: string;
                url: string;
                permissions: {
                    edit: boolean;
                    comment: boolean;
                    review: boolean;
                    fillForms: boolean;
                    modifyFilter: boolean;
                    download: boolean;
                    print: boolean;
                };
            };
            editorConfig: {
                mode: "view";
                user: {
                    id: string;
                    name: string;
                };
            };
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
    private signFetchToken;
    private requireConfig;
}
