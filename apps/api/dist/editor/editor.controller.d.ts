import type { Request, Response } from 'express';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { FileReadService } from '../files/file-read.service.js';
import { CreateEditorSessionDto } from './dto/editor-session.dto.js';
import { EditorSessionService } from './editor-session.service.js';
export declare class EditorController {
    private readonly sessions;
    private readonly reads;
    constructor(sessions: EditorSessionService, reads: FileReadService);
    create(auth: AuthPrincipal, nodeId: string, _dto: CreateEditorSessionDto): Promise<{
        session: {
            id: string;
            mode: import("@prisma/client").$Enums.EditorMode;
            status: import("@prisma/client").$Enums.EditorSessionStatus;
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
    close(auth: AuthPrincipal, sessionId: string): Promise<{
        id: string;
        status: import("@prisma/client").$Enums.EditorSessionStatus;
        mode: import("@prisma/client").$Enums.EditorMode;
        closedAt: Date | null;
    }>;
    content(sessionId: string, token: string, request: Request, response: Response): Promise<void>;
}
