import type { Request } from 'express';
import type { Response } from 'express';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { FilesService } from './files.service.js';
import { FileReadService } from './file-read.service.js';
import { MultipartUploadService } from './multipart-upload.service.js';
export declare class FilesController {
    private readonly files;
    private readonly reads;
    private readonly multipart;
    constructor(files: FilesService, reads: FileReadService, multipart: MultipartUploadService);
    createInitial(auth: AuthPrincipal, request: Request): Promise<import("./files.service.js").UploadResponse>;
    createVersion(auth: AuthPrincipal, nodeId: string, request: Request): Promise<import("./files.service.js").UploadResponse>;
    currentContent(auth: AuthPrincipal, nodeId: string, request: Request, response: Response): Promise<void>;
    currentDownload(auth: AuthPrincipal, nodeId: string, request: Request, response: Response): Promise<void>;
    historicalContent(auth: AuthPrincipal, nodeId: string, versionId: string, request: Request, response: Response): Promise<void>;
    historicalDownload(auth: AuthPrincipal, nodeId: string, versionId: string, request: Request, response: Response): Promise<void>;
    private stream;
}
