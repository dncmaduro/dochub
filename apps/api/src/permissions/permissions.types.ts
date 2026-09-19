import { DocumentRole, UserStatus } from '@dochub/database';

export interface UserPermissionEntryResponse {
  id: string;
  principalType: 'USER';
  principal: {
    id: string;
    displayName: string;
    email: string;
    status: UserStatus;
  };
  role: DocumentRole;
}

export interface GroupPermissionEntryResponse {
  id: string;
  principalType: 'GROUP';
  principal: {
    id: string;
    name: string;
    description: string | null;
  };
  role: DocumentRole;
}

export type PermissionEntryResponse =
  UserPermissionEntryResponse | GroupPermissionEntryResponse;

export interface NodePermissionsResponse {
  nodeId: string;
  inheritPermissions: boolean;
  entries: PermissionEntryResponse[];
}
