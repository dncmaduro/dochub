export type FileVersionActorType = "USER" | "PUBLIC" | "SYSTEM" | "COLLABORATIVE";
export interface Actor {
  type: FileVersionActorType;
  id?: string;
  displayName: string | null;
}
export interface LastModified {
  at: string;
  actor: Actor;
}
export interface Node {
  id: string;
  parentId: string | null;
  type: "FILE" | "FOLDER";
  name: string;
  createdAt: string;
  updatedAt: string;
  lastModified: LastModified;
  backing?:
    | { type: "LOCAL" }
    | {
        type: "GOOGLE_DRIVE";
        driveFileId: string;
        webViewLink: string | null;
        normalizedType: DriveFileType;
        sourceStatus: "CONNECTED" | "STALE" | "UNAVAILABLE";
        driveModifiedTime: string | null;
      };
  capabilities: string[];
  processing?: { contentSearch: "READY" | "PROCESSING" | "FAILED" } | null;
}
export type NodeSortBy = "name" | "lastModified";
export type NodeSortDirection = "asc" | "desc";
export interface Breadcrumb {
  id: string;
  name: string;
  type: "FILE" | "FOLDER";
}
export interface BreadcrumbPage {
  items: Breadcrumb[];
  truncated: boolean;
}
export interface SearchItem {
  id: string;
  type: "FILE" | "FOLDER";
  name: string;
  updatedAt: string;
}
export interface SearchPage {
  items: SearchItem[];
  nextCursor: string | null;
}
export interface CollectionItem extends Node {
  favoritedAt?: string;
  lastAccessedAt?: string;
}
export interface EditorSession {
  session: { id: string; mode: "VIEW" | "EDIT" };
  documentServer: { apiUrl: string };
  config: Record<string, unknown>;
}
export interface PreviewSession { sessionId: string; nodeId: string; contentUrl: string; expiresAt: string; mimeType: string; filename: string; size: string; }
export type DocumentRole = "VIEWER" | "EDITOR" | "OWNER";
export interface SharingState {
  nodeId: string;
  generalAccessRole: "RESTRICTED" | "VIEWER" | "EDITOR";
  documentUrl: string;
  canManageSharing: boolean;
}
export interface DocumentAccess {
  node: { id: string; type: "FILE" | "FOLDER"; name: string; mimeType: string | null };
  access: {
    mode: "AUTHENTICATED" | "PUBLIC";
    generalAccessRole: "RESTRICTED" | "VIEWER" | "EDITOR";
    editorMode: "VIEW" | "EDIT";
    canPreview: boolean;
    canDownload: boolean;
  };
}
export interface EditorSessionState {
  id: string;
  state: "ACTIVE" | "FINALIZING" | "CLOSED" | "FAILED";
  status: "ACTIVE" | "CLOSED" | "FAILED";
}
export interface PermissionEntry {
  id: string;
  principalType: "USER" | "GROUP";
  principal: {
    id: string;
    displayName?: string;
    email?: string;
    status?: string;
    name?: string;
    description?: string | null;
  };
  role: DocumentRole;
}
export interface PermissionsState {
  nodeId: string;
  inheritPermissions: boolean;
  entries: PermissionEntry[];
}
export interface AdminUser {
  id: string;
  displayName: string;
  email: string;
  status: string;
  systemRole: SystemRole;
  createdAt: string;
  updatedAt: string;
}
export interface AdminGroup {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
}
export interface SharingPrincipal {
  type: "USER" | "GROUP";
  id: string;
  displayName?: string;
  email?: string;
  name?: string;
}
export interface TrashItem {
  trashOperationId: string;
  rootNodeId: string;
  name: string;
  type: "FILE" | "FOLDER";
  trashedAt: string;
  expiresAt: string;
  canRestore: boolean;
  canPurge: boolean;
}
export interface FileVersion {
  id: string;
  versionNumber: number;
  source: "UPLOAD" | "EDITOR" | "RESTORE" | "SYSTEM";
  sourceVersionId: string | null;
  originalFilename: string;
  mimeType: string;
  extension: string | null;
  sizeBytes: string;
  createdAt: string;
  actor: Actor;
  isCurrent: boolean;
}

interface NodePage {
  items: Node[];
  nextCursor: string | null;
}
interface UploadResponse {
  node: Node;
}
export type SystemRole = "ADMIN" | "DOCUMENT_MANAGER" | "VIEWER";
export type OfficeFileKind = "DOCX" | "XLSX" | "PPTX";
export type NativeDocumentKind = "DOCUMENT" | "SPREADSHEET" | "PRESENTATION";
export type UserStatus = "INVITED" | "PENDING_APPROVAL" | "ACTIVE" | "SUSPENDED";
export interface CurrentUser {
  displayName: string;
  email: string;
  systemRole: SystemRole;
  status: UserStatus;
  googleConnected: boolean;
}
export type DriveSyncStatus = "NEVER_SYNCED" | "SYNCING" | "SYNCED" | "FAILED";
export type DriveFileType = "FOLDER" | "GOOGLE_DOC" | "GOOGLE_SHEET" | "GOOGLE_SLIDE" | "PDF" | "IMAGE" | "VIDEO" | "DOCX" | "XLSX" | "PPTX" | "BINARY";
export type DriveFileLocation = "MY_DRIVE" | "SHARED_WITH_ME" | "SHARED_DRIVE" | "UNKNOWN";
export interface DriveConnection {
  connected: boolean;
  id?: string;
  googleAccountId?: string | null;
  googleEmail?: string | null;
  connectedAt?: string;
  updatedAt?: string;
  syncStatus: DriveSyncStatus;
  lastSyncStartedAt?: string | null;
  lastSyncCompletedAt?: string | null;
  lastSyncError?: string | null;
  revokedAt?: string | null;
  authorizedScopes: string[];
  canWrite: boolean;
}
export interface NativeDocumentCreation {
  operationId: string;
  kind: NativeDocumentKind;
  nodeId: string;
  fileId: string;
  driveFileId: string;
  parentId: string | null;
  name: string;
  webViewLink: string | null;
  driveModifiedTime: string | null;
}
export interface DriveFile {
  id: string;
  driveFileId: string;
  name: string;
  mimeType: string;
  normalizedType: DriveFileType;
  webViewLink: string | null;
  driveModifiedTime: string | null;
  driveCreatedTime: string | null;
  trashed: boolean;
  driveParents: string[];
  location: DriveFileLocation;
  sharedDriveId: string | null;
  sizeBytes: string | null;
  syncedAt: string;
  sourceStatus: "CONNECTED" | "STALE" | "UNAVAILABLE";
  docsHubNodeId: string | null;
}
export interface DriveFilePage {
  items: DriveFile[];
  nextCursor: string | null;
}
interface RefreshResponse {
  accessToken: string;
  systemRole: SystemRole;
}

const apiOrigin = (
  import.meta.env.VITE_API_ORIGIN ?? "http://localhost:3000"
).replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class ApiClient {
  private accessToken: string | null = null;
  private refreshPromise: Promise<RefreshResponse> | null = null;

  googleAuthUrl() {
    return `${apiOrigin}/auth/google`;
  }

  refresh(): Promise<RefreshResponse> {
    if (this.refreshPromise) return this.refreshPromise;

    const refresh = (async () => {
      const response = await fetch(`${apiOrigin}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw await this.error(response);
      const body = (await response.json()) as RefreshResponse;
      this.accessToken = body.accessToken;
      return body;
    })();
    this.refreshPromise = refresh;
    void refresh.then(
      () => {
        if (this.refreshPromise === refresh) this.refreshPromise = null;
      },
      () => {
        if (this.refreshPromise === refresh) this.refreshPromise = null;
      },
    );
    return refresh;
  }

  async currentUser() {
    return this.request<CurrentUser>("/auth/me");
  }

  async driveConnection() {
    return this.request<DriveConnection>("/drive/connection");
  }

  async startDriveConnection(mode: "READ" | "WRITE" = "READ") {
    const result = await this.request<{ authorizationUrl: string }>(
      "/drive/connection/authorize",
      {
        method: "POST",
        ...(mode === "WRITE"
          ? { body: JSON.stringify({ mode }) }
          : {}),
      },
    );
    window.location.assign(result.authorizationUrl);
  }

  async createNativeDocument(
    kind: NativeDocumentKind,
    parentId: string | null,
    locale: "en" | "vi",
    idempotencyKey: string,
  ) {
    return this.request<NativeDocumentCreation>("/drive/documents", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ kind, parentId, locale }),
    });
  }

  async syncDrive() {
    return this.request<DriveConnection>("/drive/connection/sync", {
      method: "POST",
    });
  }

  async disconnectDrive() {
    return this.request<DriveConnection>("/drive/connection/disconnect", {
      method: "POST",
    });
  }

  async listDriveFiles(q = "", cursor?: string, limit = 50) {
    const parameters = new URLSearchParams({ limit: String(limit) });
    if (q.trim()) parameters.set("q", q.trim());
    if (cursor) parameters.set("cursor", cursor);
    return this.request<DriveFilePage>(`/drive/files?${parameters}`);
  }

  async addDriveFileToDocsHub(driveFileId: string, parentId: string | null) {
    return this.request<{ nodeId: string; name: string }>(
      `/drive/files/${encodeURIComponent(driveFileId)}/add-to-docshub`,
      {
        method: "POST",
        body: JSON.stringify({ parentId }),
      },
    );
  }

  async logout() {
    try {
      await this.raw("/auth/logout", { method: "POST" });
    } finally {
      this.accessToken = null;
    }
  }

  async listNodes(
    folderId: string | null,
    sortBy: NodeSortBy = "name",
    sortDirection: NodeSortDirection = "asc",
    signal?: AbortSignal,
  ) {
    const parameters = new URLSearchParams({ sortBy, sortDirection });
    const path = folderId
      ? `/nodes/${folderId}/children?${parameters}`
      : `/nodes/root?${parameters}`;
    return this.request<NodePage>(path, { signal });
  }
  async breadcrumb(nodeId: string, signal?: AbortSignal) {
    return (await this.breadcrumbPage(nodeId, signal)).items;
  }
  async breadcrumbPage(nodeId: string, signal?: AbortSignal) {
    return this.request<BreadcrumbPage>(`/nodes/${nodeId}/breadcrumb`, { signal });
  }
  async search(query: string, cursor?: string, signal?: AbortSignal) {
    const parameters = new URLSearchParams({ q: query });
    if (cursor) parameters.set("cursor", cursor);
    return this.request<SearchPage>(`/search?${parameters}`, { signal });
  }
  async listRecent() {
    return this.request<{ items: CollectionItem[] }>("/recent");
  }
  async recordRecent(nodeId: string) {
    return this.request<void>(`/nodes/${nodeId}/recent`, { method: "POST" });
  }
  async listFavorites() {
    return this.request<{ items: CollectionItem[] }>("/favorites");
  }
  async addFavorite(nodeId: string) {
    return this.request<{ nodeId: string; favorited: boolean }>(
      `/nodes/${nodeId}/favorite`,
      { method: "POST" },
    );
  }
  async removeFavorite(nodeId: string) {
    return this.request<{ nodeId: string; favorited: boolean }>(
      `/nodes/${nodeId}/favorite`,
      { method: "DELETE" },
    );
  }
  async createFolder(name: string, parentId: string | null) {
    return this.request<Node>("/folders", {
      method: "POST",
      body: JSON.stringify({ name, parentId }),
    });
  }
  async createOfficeFile(kind: OfficeFileKind, parentId: string | null, locale: "en" | "vi" = "en") {
    return this.request<UploadResponse>("/files/create", {
      method: "POST",
      body: JSON.stringify({ kind, parentId, locale }),
    });
  }
  async getNode(nodeId: string) {
    return this.request<Node>(`/nodes/${nodeId}`);
  }
  async renameNode(nodeId: string, name: string) {
    return this.request<Node>(`/nodes/${nodeId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }
  async moveNode(nodeId: string, parentId: string | null) {
    return this.request<Node>(`/nodes/${nodeId}/move`, {
      method: "POST",
      body: JSON.stringify({ parentId }),
    });
  }
  async removeDriveReference(nodeId: string) {
    return this.request<{ nodeId: string; removed: boolean }>(
      `/nodes/${nodeId}/drive-reference`,
      { method: "DELETE" },
    );
  }
  async createEditorSession(nodeId: string, mode?: "VIEW" | "EDIT") {
    return this.request<EditorSession>(`/nodes/${nodeId}/editor-sessions`, {
      method: "POST",
      body: JSON.stringify(mode ? { mode } : {}),
    });
  }
  async documentAccess(nodeId: string) {
    return this.request<DocumentAccess>(`/documents/${nodeId}`);
  }
  async createDocumentEditorSession(nodeId: string) {
    return this.request<EditorSession>(`/documents/${nodeId}/editor-sessions`, { method: "POST" });
  }
  async loadDocumentContent(nodeId: string) {
    return this.raw(`/documents/${nodeId}/content`).then((response) => response.blob());
  }
  async createPreviewSession(nodeId: string) {
    const result = await this.request<PreviewSession | { previewable: false }>(`/nodes/${nodeId}/preview-session`, { method: "POST" });
    return "previewable" in result ? null : { ...result, contentUrl: `${apiOrigin}${result.contentUrl}` };
  }
  async closeEditorSession(sessionId: string) {
    return this.request<EditorSessionState>(`/editor-sessions/${sessionId}/close`, {
      method: "POST",
    });
  }
  async editorSessionStatus(sessionId: string) {
    return this.request<EditorSessionState>(`/editor-sessions/${sessionId}/status`);
  }
  async sharing(nodeId: string) {
    return this.request<SharingState>(`/nodes/${nodeId}/sharing`);
  }
  async setGeneralAccessRole(nodeId: string, generalAccessRole: SharingState["generalAccessRole"]) {
    return this.request<{ nodeId: string; generalAccessRole: SharingState["generalAccessRole"]; documentUrl: string }>(
      `/nodes/${nodeId}/sharing`,
      { method: "PATCH", body: JSON.stringify({ generalAccessRole }) },
    );
  }
  async permissions(nodeId: string) {
    return this.request<PermissionsState>(`/nodes/${nodeId}/permissions`);
  }
  async setUserPermission(nodeId: string, userId: string, role: DocumentRole) {
    return this.request<PermissionEntry>(
      `/nodes/${nodeId}/permissions/users/${userId}`,
      { method: "PUT", body: JSON.stringify({ role }) },
    );
  }
  async setGroupPermission(
    nodeId: string,
    groupId: string,
    role: DocumentRole,
  ) {
    return this.request<PermissionEntry>(
      `/nodes/${nodeId}/permissions/groups/${groupId}`,
      { method: "PUT", body: JSON.stringify({ role }) },
    );
  }
  async removePermission(nodeId: string, entry: PermissionEntry) {
    await this.request<void>(
      `/nodes/${nodeId}/permissions/${entry.principalType === "USER" ? "users" : "groups"}/${entry.principal.id}`,
      { method: "DELETE" },
    );
  }
  async setInheritance(nodeId: string, inheritPermissions: boolean) {
    return this.request<{ nodeId: string; inheritPermissions: boolean }>(
      `/nodes/${nodeId}/permissions/settings`,
      { method: "PATCH", body: JSON.stringify({ inheritPermissions }) },
    );
  }
  async listAdminUsers() {
    return this.request<{ items: AdminUser[] }>("/admin/users?limit=100");
  }
  async createAdminUser(input: { email: string; displayName: string; systemRole: SystemRole }) {
    return this.request<AdminUser>("/admin/users", { method: "POST", body: JSON.stringify(input) });
  }
  async updateAdminUser(userId: string, input: Partial<Pick<AdminUser, "displayName" | "systemRole">>) {
    return this.request<AdminUser>(`/admin/users/${userId}`, { method: "PATCH", body: JSON.stringify(input) });
  }
  async approveAdminUser(userId: string) { return this.request<AdminUser>(`/admin/users/${userId}/approve`, { method: "POST" }); }
  async suspendAdminUser(userId: string) { return this.request<AdminUser>(`/admin/users/${userId}/suspend`, { method: "POST" }); }
  async reactivateAdminUser(userId: string) { return this.request<AdminUser>(`/admin/users/${userId}/reactivate`, { method: "POST" }); }
  async listAdminGroups() {
    return this.request<{ items: AdminGroup[] }>("/admin/groups?limit=100");
  }
  async createAdminGroup(input: { name: string }) { return this.request<AdminGroup>("/admin/groups", { method: "POST", body: JSON.stringify(input) }); }
  async updateAdminGroup(groupId: string, input: { name: string }) { return this.request<AdminGroup>(`/admin/groups/${groupId}`, { method: "PATCH", body: JSON.stringify(input) }); }
  async listAdminGroupMembers(groupId: string) { return this.request<{ items: { user: AdminUser; addedAt: string }[] }>(`/admin/groups/${groupId}/members?limit=100`); }
  async addAdminGroupMember(groupId: string, userId: string) { await this.request<void>(`/admin/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ userId }) }); }
  async removeAdminGroupMember(groupId: string, userId: string) { await this.request<void>(`/admin/groups/${groupId}/members/${userId}`, { method: "DELETE" }); }
  async moveToTrash(nodeId: string) {
    return this.request<{ operation: { id: string } }>(`/nodes/${nodeId}`, {
      method: "DELETE",
    });
  }
  async listTrash() {
    return this.request<{ items: TrashItem[] }>("/trash");
  }
  async restoreTrash(operationId: string) {
    await this.request<void>(`/trash/${operationId}/restore`, {
      method: "POST",
    });
  }
  async purgeTrash(operationId: string) {
    await this.request<void>(`/trash/${operationId}`, { method: "DELETE" });
  }
  async listVersions(nodeId: string) {
    return this.request<{ nodeId: string; items: FileVersion[] }>(
      `/nodes/${nodeId}/versions`,
    );
  }
  async restoreVersion(nodeId: string, versionId: string) {
    return this.request<UploadResponse>(
      `/nodes/${nodeId}/versions/${versionId}/restore`,
      { method: "POST" },
    );
  }
  async findPrincipals(query: string) {
    return this.request<{ items: SharingPrincipal[] }>(
      `/sharing/principals?q=${encodeURIComponent(query)}`,
    );
  }

  async upload(file: File, parentId: string | null) {
    const form = new FormData();
    form.append("parentId", parentId ?? "");
    form.append("file", file);
    return this.request<UploadResponse>("/files", {
      method: "POST",
      body: form,
    });
  }

  async download(node: Node) {
    return this.downloadPath(`/nodes/${node.id}/download`, node.name);
  }

  async downloadNode(nodeId: string, name: string) {
    return this.downloadPath(`/nodes/${nodeId}/download`, name);
  }

  async downloadVersion(node: Node, version: FileVersion) {
    return this.downloadPath(
      `/nodes/${node.id}/versions/${version.id}/download`,
      version.originalFilename,
    );
  }

  private async downloadPath(path: string, name: string) {
    const response = await this.raw(path);
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  }

  private async request<T>(path: string, init: RequestInit = {}) {
    const response = await this.raw(path, init);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async raw(
    path: string,
    init: RequestInit = {},
    refreshed = false,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.accessToken)
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    if (init.body && !(init.body instanceof FormData))
      headers.set("Content-Type", "application/json");
    const response = await fetch(`${apiOrigin}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    if (response.status === 401 && !refreshed) {
      await this.refresh();
      return this.raw(path, init, true);
    }
    if (!response.ok) throw await this.error(response);
    return response;
  }

  private async error(response: Response) {
    let message =
      response.status === 401
        ? "Your session has ended. Please sign in again."
        : "The request could not be completed.";
    try {
      const body = (await response.json()) as { message?: string | string[] };
      if (Array.isArray(body.message)) message = body.message[0] ?? message;
      else if (body.message) message = body.message;
    } catch {
      /* Use the safe fallback. */
    }
    return new ApiError(message, response.status);
  }
}
