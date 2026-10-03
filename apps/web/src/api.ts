export interface Node {
  id: string;
  parentId: string | null;
  type: "FILE" | "FOLDER";
  name: string;
  createdAt: string;
  updatedAt: string;
  capabilities: string[];
  processing?: { contentSearch: "READY" | "PROCESSING" | "FAILED" } | null;
}
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
  session: { id: string };
  documentServer: { apiUrl: string };
  config: Record<string, unknown>;
}
export interface PreviewSession { sessionId: string; nodeId: string; contentUrl: string; expiresAt: string; mimeType: string; filename: string; size: string; }
export type DocumentRole = "VIEWER" | "EDITOR" | "OWNER";
export interface SharingState {
  nodeId: string;
  publicAccess: boolean;
  shareLink: { exists: boolean };
  canManageSharing: boolean;
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
}
export interface AdminGroup {
  id: string;
  name: string;
  description: string | null;
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
  isCurrent: boolean;
}

interface NodePage {
  items: Node[];
  nextCursor: string | null;
}
interface UploadResponse {
  node: Node;
}
export type SystemRole = "ADMIN" | "MEMBER";
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

  async listNodes(folderId: string | null) {
    return this.request<NodePage>(
      folderId ? `/nodes/${folderId}/children` : "/nodes/root",
    );
  }
  async breadcrumb(nodeId: string) {
    return (await this.breadcrumbPage(nodeId)).items;
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
  async getNode(nodeId: string) {
    return this.request<Node>(`/nodes/${nodeId}`);
  }
  async renameNode(nodeId: string, name: string) {
    return this.request<Node>(`/nodes/${nodeId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }
  async createEditorSession(nodeId: string) {
    return this.request<EditorSession>(`/nodes/${nodeId}/editor-sessions`, {
      method: "POST",
      body: JSON.stringify({ mode: "VIEW" }),
    });
  }
  async createPreviewSession(nodeId: string) {
    const result = await this.request<PreviewSession | { previewable: false }>(`/nodes/${nodeId}/preview-session`, { method: "POST" });
    return "previewable" in result ? null : { ...result, contentUrl: `${apiOrigin}${result.contentUrl}` };
  }
  async closeEditorSession(sessionId: string) {
    await this.request<void>(`/editor-sessions/${sessionId}/close`, {
      method: "POST",
    });
  }
  async sharing(nodeId: string) {
    return this.request<SharingState>(`/nodes/${nodeId}/sharing`);
  }
  async createShareLink(nodeId: string) {
    return this.request<{
      nodeId: string;
      shareLink: { id: string; created: boolean; url: string | null };
    }>(`/nodes/${nodeId}/share-link`, { method: "POST" });
  }
  async resetShareLink(nodeId: string) {
    return this.request<{
      nodeId: string;
      shareLink: { id: string; created: boolean; url: string | null };
    }>(`/nodes/${nodeId}/share-link/reset`, { method: "POST" });
  }
  async revokeShareLink(nodeId: string) {
    await this.request<void>(`/nodes/${nodeId}/share-link`, {
      method: "DELETE",
    });
  }
  async setPublicAccess(nodeId: string, publicAccess: boolean) {
    return this.request<{ nodeId: string; publicAccess: boolean }>(
      `/nodes/${nodeId}/sharing`,
      { method: "PATCH", body: JSON.stringify({ publicAccess }) },
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
  async listAdminGroups() {
    return this.request<{ items: AdminGroup[] }>("/admin/groups?limit=100");
  }
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
