import { NodeType } from '@dochub/database';
import { DocumentCapability } from '../authorization/document-capability.js';
import type { ProcessingStatus } from '../common/file-processing-state.js';

export interface NodeResponse {
  id: string;
  parentId: string | null;
  type: NodeType;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  capabilities: DocumentCapability[];
  processing: { contentSearch: ProcessingStatus } | null;
}

export interface NodePage {
  items: NodeResponse[];
  nextCursor: string | null;
}

export interface BreadcrumbResponse {
  items: Array<{ id: string; name: string; type: NodeType }>;
  truncated: boolean;
}
