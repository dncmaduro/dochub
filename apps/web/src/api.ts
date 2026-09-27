export interface Node { id: string; parentId: string | null; type: 'FILE' | 'FOLDER'; name: string; createdAt: string; updatedAt: string; capabilities: string[] }
export interface Breadcrumb { id: string; name: string; type: 'FILE' | 'FOLDER' }
export interface EditorSession { session: { id: string }; documentServer: { apiUrl: string }; config: Record<string, unknown> }

interface NodePage { items: Node[]; nextCursor: string | null }
interface UploadResponse { node: Node }
export type SystemRole = 'ADMIN' | 'MEMBER'
interface RefreshResponse { accessToken: string; systemRole: SystemRole }

const apiOrigin = (import.meta.env.VITE_API_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '')

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export class ApiClient {
  private accessToken: string | null = null

  googleAuthUrl() { return `${apiOrigin}/auth/google` }

  async refresh() {
    const response = await fetch(`${apiOrigin}/auth/refresh`, { method: 'POST', credentials: 'include' })
    if (!response.ok) throw await this.error(response)
    const body = await response.json() as RefreshResponse
    this.accessToken = body.accessToken
    return body
  }

  async listNodes(folderId: string | null) { return this.request<NodePage>(folderId ? `/nodes/${folderId}/children` : '/nodes/root') }
  async breadcrumb(nodeId: string) { return (await this.request<{ items: Breadcrumb[] }>(`/nodes/${nodeId}/breadcrumb`)).items }
  async createFolder(name: string, parentId: string | null) { return this.request<Node>('/folders', { method: 'POST', body: JSON.stringify({ name, parentId }) }) }
  async renameNode(nodeId: string, name: string) { return this.request<Node>(`/nodes/${nodeId}`, { method: 'PATCH', body: JSON.stringify({ name }) }) }
  async createEditorSession(nodeId: string) { return this.request<EditorSession>(`/nodes/${nodeId}/editor-sessions`, { method: 'POST', body: JSON.stringify({ mode: 'VIEW' }) }) }
  async closeEditorSession(sessionId: string) { await this.request<void>(`/editor-sessions/${sessionId}/close`, { method: 'POST' }) }

  async upload(file: File, parentId: string | null) {
    const form = new FormData()
    form.append('parentId', parentId ?? '')
    form.append('file', file)
    return this.request<UploadResponse>('/files', { method: 'POST', body: form })
  }

  async download(node: Node) {
    const response = await this.raw(`/nodes/${node.id}/download`)
    const blob = await response.blob()
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = node.name
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(link.href)
  }

  private async request<T>(path: string, init: RequestInit = {}) {
    const response = await this.raw(path, init)
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }

  private async raw(path: string, init: RequestInit = {}, refreshed = false): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`)
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
    const response = await fetch(`${apiOrigin}${path}`, { ...init, headers, credentials: 'include' })
    if (response.status === 401 && !refreshed) {
      await this.refresh()
      return this.raw(path, init, true)
    }
    if (!response.ok) throw await this.error(response)
    return response
  }

  private async error(response: Response) {
    let message = response.status === 401 ? 'Your session has ended. Please sign in again.' : 'The request could not be completed.'
    try {
      const body = await response.json() as { message?: string | string[] }
      if (Array.isArray(body.message)) message = body.message[0] ?? message
      else if (body.message) message = body.message
    } catch { /* Use the safe fallback. */ }
    return new ApiError(message, response.status)
  }
}
