import { DatabaseService } from '../database/database.service.js';
export declare class HealthController {
    private readonly database;
    constructor(database: DatabaseService);
    getHealth(): Promise<{
        status: 'ok';
        database: 'up';
    }>;
}
