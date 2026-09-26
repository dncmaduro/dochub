import type { AuthPrincipal } from '../auth/auth.types.js';
import { SharingNodeParamDto, UpdateSharingDto } from './dto/update-sharing.dto.js';
import { SharingService } from './sharing.service.js';
export declare class SharingController {
    private readonly sharing;
    constructor(sharing: SharingService);
    getState(auth: AuthPrincipal, params: SharingNodeParamDto): Promise<import("./sharing.types.js").SharingState>;
    ensureLink(auth: AuthPrincipal, params: SharingNodeParamDto): Promise<import("./sharing.types.js").ShareLinkResponse>;
    resetLink(auth: AuthPrincipal, params: SharingNodeParamDto): Promise<import("./sharing.types.js").ShareLinkResponse>;
    revokeLink(auth: AuthPrincipal, params: SharingNodeParamDto): Promise<void>;
    updatePublicAccess(auth: AuthPrincipal, params: SharingNodeParamDto, dto: UpdateSharingDto): Promise<{
        nodeId: string;
        publicAccess: boolean;
    }>;
}
