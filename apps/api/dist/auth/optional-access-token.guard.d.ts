import { CanActivate, ExecutionContext } from '@nestjs/common';
import { AccessTokenGuard } from './access-token.guard.js';
export declare class OptionalAccessTokenGuard implements CanActivate {
    private readonly accessTokens;
    constructor(accessTokens: AccessTokenGuard);
    canActivate(context: ExecutionContext): Promise<boolean>;
}
