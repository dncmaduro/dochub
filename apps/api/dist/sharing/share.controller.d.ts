import type { Request, Response } from 'express';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { FileReadService } from '../files/file-read.service.js';
import { ShareResolutionService } from './share-resolution.service.js';
export declare class ShareController {
    private readonly resolution;
    private readonly reads;
    constructor(resolution: ShareResolutionService, reads: FileReadService);
    resolve(token: string, auth: AuthPrincipal | undefined): Promise<{
        node: {
            id: string;
            type: import("@prisma/client").$Enums.NodeType;
            name: string;
        };
        access: {
            mode: "PUBLIC" | "AUTHENTICATED";
            canPreview: boolean;
            canDownload: boolean;
        };
    }>;
    content(token: string, auth: AuthPrincipal | undefined, request: Request, response: Response): Promise<void>;
    download(token: string, auth: AuthPrincipal | undefined, request: Request, response: Response): Promise<void>;
    private stream;
}
