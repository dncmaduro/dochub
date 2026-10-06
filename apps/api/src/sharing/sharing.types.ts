export interface SharingState {
  nodeId: string;
  generalAccessRole: 'RESTRICTED' | 'VIEWER' | 'EDITOR';
  documentUrl: string;
  canManageSharing: boolean;
}
