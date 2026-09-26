export interface SharingState {
  nodeId: string;
  publicAccess: boolean;
  shareLink: { exists: boolean };
  canManageSharing: boolean;
}

export interface ShareLinkResponse {
  nodeId: string;
  shareLink:
    | { id: string; created: true; url: string }
    | { id: string; created: false; url: null };
}
