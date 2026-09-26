import { CanActivate, ExecutionContext } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
export declare class SystemAdminGuard implements CanActivate {
    private readonly database;
    constructor(database: DatabaseService);
    canActivate(context: ExecutionContext): Promise<boolean>;
}
