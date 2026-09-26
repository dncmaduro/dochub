import { NodeType } from '@dochub/database';
export declare class SearchQueryDto {
    q: string;
    type?: NodeType;
    limit?: number;
    cursor?: string;
}
