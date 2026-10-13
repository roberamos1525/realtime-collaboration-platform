import {
  isApiErrorEnvelope,
  type ActivityDto,
  type AuthResult,
  type CommentAnchor,
  type CommentDto,
  type DocumentDetailDto,
  type DocumentDto,
  type ErrorCode,
  type MemberDto,
  type NotificationDto,
  type Page,
  type PublicUser,
  type Role,
  type SearchHit,
  type TaskDto,
  type TaskPriority,
  type TaskStatus,
  type UserDto,
  type VersionDetailDto,
  type VersionDto,
  type WorkspaceDto,
} from "@rcp/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "network",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** First field-level validation message, if any. */
  get fieldMessage(): string | null {
    const issues = (this.details as { issues?: Array<{ path: string; message: string }> } | undefined)?.issues;
    const first = issues?.[0];
    return first ? `${first.path ? `${first.path}: ` : ""}${first.message}` : null;
  }
}

export interface StoredSession {
  readonly user: UserDto;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly storage?: KeyValueStorage | null;
  readonly now?: () => number;
}

const STORAGE_KEY = "rcp.session";

export type TaskInput = {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string | null;
  dueDate?: string | null;
  labels?: string[];
  documentId?: string | null;
};

/**
 * Typed HTTP client. Unwraps `{ data }` envelopes, converts `{ error }`
 * envelopes into {@link ApiError}, and transparently refreshes the access
 * token once when a request fails with 401 (concurrent refreshes are
 * coalesced into a single request).
 */
export class ApiClient {
  private session: StoredSession | null = null;
  private refreshing: Promise<boolean> | null = null;
  private readonly listeners = new Set<(session: StoredSession | null) => void>();
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly storage: KeyValueStorage | null;
  private readonly now: () => number;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "";
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.storage = options.storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : options.storage;
    this.now = options.now ?? Date.now;
    const raw = this.storage?.getItem(STORAGE_KEY);
    if (raw) {
      try {
        this.session = JSON.parse(raw) as StoredSession;
      } catch {
        this.storage?.removeItem(STORAGE_KEY);
      }
    }
  }

  get currentSession(): StoredSession | null {
    return this.session;
  }

  onSessionChange(listener: (session: StoredSession | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSession(result: AuthResult): void {
    this.session = {
      user: result.user,
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
      refreshToken: result.refreshToken,
    };
    this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.session));
    for (const l of this.listeners) l(this.session);
  }

  clearSession(): void {
    this.session = null;
    this.storage?.removeItem(STORAGE_KEY);
    for (const l of this.listeners) l(null);
  }

  /** Returns an access token valid for at least 30 s, refreshing if needed. */
  async freshAccessToken(): Promise<string | null> {
    if (!this.session) return null;
    if (Date.parse(this.session.accessTokenExpiresAt) - this.now() < 30_000) {
      if (!(await this.refresh())) return null;
    }
    return this.session?.accessToken ?? null;
  }

  refresh(): Promise<boolean> {
    if (!this.session) return Promise.resolve(false);
    this.refreshing ??= (async () => {
      try {
        const result = await this.request<AuthResult>("POST", "/api/auth/refresh", { refreshToken: this.session?.refreshToken }, { auth: false });
        this.setSession(result);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code !== "network") this.clearSession();
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async request<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean; retry?: boolean } = {}): Promise<T> {
    const auth = opts.auth ?? true;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && this.session) headers.Authorization = `Bearer ${this.session.accessToken}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new ApiError(0, "network", `network error: ${(err as Error).message}`);
    }
    if (res.status === 401 && auth && (opts.retry ?? true) && this.session) {
      if (await this.refresh()) return this.request<T>(method, path, body, { ...opts, retry: false });
    }
    if (res.status === 204) return undefined as T;
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      if (isApiErrorEnvelope(payload)) throw new ApiError(res.status, payload.error.code, payload.error.message, payload.error.details);
      throw new ApiError(res.status, "internal", `request failed with status ${res.status}`);
    }
    return (payload as { data: T }).data;
  }

  // ------------------------------------------------------------------ auth

  async register(input: { email: string; username: string; displayName: string; password: string }): Promise<UserDto> {
    const result = await this.request<AuthResult>("POST", "/api/auth/register", input, { auth: false });
    this.setSession(result);
    return result.user;
  }

  async login(login: string, password: string): Promise<UserDto> {
    const result = await this.request<AuthResult>("POST", "/api/auth/login", { login, password }, { auth: false });
    this.setSession(result);
    return result.user;
  }

  async logout(): Promise<void> {
    try {
      if (this.session) await this.request<void>("POST", "/api/auth/logout", {}, { retry: false });
    } catch {
      // Logging out locally is what matters; the server session expires anyway.
    } finally {
      this.clearSession();
    }
  }

  searchUsers(q: string): Promise<PublicUser[]> {
    return this.request("GET", `/api/users?q=${encodeURIComponent(q)}`);
  }

  // ------------------------------------------------------------ workspaces

  listWorkspaces(): Promise<WorkspaceDto[]> {
    return this.request("GET", "/api/workspaces");
  }
  createWorkspace(name: string, description = ""): Promise<WorkspaceDto> {
    return this.request("POST", "/api/workspaces", { name, description });
  }
  getWorkspace(id: string): Promise<WorkspaceDto> {
    return this.request("GET", `/api/workspaces/${id}`);
  }
  updateWorkspace(id: string, patch: { name?: string; description?: string }): Promise<WorkspaceDto> {
    return this.request("PATCH", `/api/workspaces/${id}`, patch);
  }
  deleteWorkspace(id: string): Promise<void> {
    return this.request("DELETE", `/api/workspaces/${id}`);
  }
  listMembers(id: string): Promise<MemberDto[]> {
    return this.request("GET", `/api/workspaces/${id}/members`);
  }
  addMember(id: string, identifier: string, role: Exclude<Role, "owner">): Promise<MemberDto[]> {
    return this.request("POST", `/api/workspaces/${id}/members`, { identifier, role });
  }
  changeRole(id: string, userId: string, role: Exclude<Role, "owner">): Promise<MemberDto[]> {
    return this.request("PATCH", `/api/workspaces/${id}/members/${userId}`, { role });
  }
  removeMember(id: string, userId: string): Promise<void> {
    return this.request("DELETE", `/api/workspaces/${id}/members/${userId}`);
  }
  activity(id: string, cursor?: string): Promise<Page<ActivityDto>> {
    return this.request("GET", `/api/workspaces/${id}/activity?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  }

  // ------------------------------------------------------------- documents

  listDocuments(workspaceId: string): Promise<DocumentDto[]> {
    return this.request("GET", `/api/workspaces/${workspaceId}/documents`);
  }
  createDocument(workspaceId: string, title: string, content = ""): Promise<DocumentDetailDto> {
    return this.request("POST", `/api/workspaces/${workspaceId}/documents`, { title, content });
  }
  getDocument(id: string): Promise<DocumentDetailDto> {
    return this.request("GET", `/api/documents/${id}`);
  }
  renameDocument(id: string, title: string): Promise<DocumentDto> {
    return this.request("PATCH", `/api/documents/${id}`, { title });
  }
  deleteDocument(id: string): Promise<void> {
    return this.request("DELETE", `/api/documents/${id}`);
  }
  listVersions(id: string): Promise<VersionDto[]> {
    return this.request("GET", `/api/documents/${id}/versions`);
  }
  getVersion(id: string, versionId: string): Promise<VersionDetailDto> {
    return this.request("GET", `/api/documents/${id}/versions/${versionId}`);
  }
  createVersion(id: string, label: string): Promise<VersionDto> {
    return this.request("POST", `/api/documents/${id}/versions`, { label });
  }
  restoreVersion(id: string, versionId: string): Promise<DocumentDetailDto> {
    return this.request("POST", `/api/documents/${id}/versions/${versionId}/restore`);
  }

  // -------------------------------------------------------------- comments

  listComments(documentId: string): Promise<CommentDto[]> {
    return this.request("GET", `/api/documents/${documentId}/comments`);
  }
  createComment(documentId: string, body: string, opts: { anchor?: CommentAnchor; parentId?: string } = {}): Promise<CommentDto> {
    return this.request("POST", `/api/documents/${documentId}/comments`, { body, ...opts });
  }
  editComment(id: string, body: string): Promise<CommentDto> {
    return this.request("PATCH", `/api/comments/${id}`, { body });
  }
  setCommentResolved(id: string, resolved: boolean): Promise<CommentDto> {
    return this.request("POST", `/api/comments/${id}/${resolved ? "resolve" : "reopen"}`);
  }
  deleteComment(id: string): Promise<void> {
    return this.request("DELETE", `/api/comments/${id}`);
  }

  // ----------------------------------------------------------------- tasks

  listTasks(workspaceId: string): Promise<TaskDto[]> {
    return this.request("GET", `/api/workspaces/${workspaceId}/tasks`);
  }
  createTask(workspaceId: string, input: TaskInput): Promise<TaskDto> {
    return this.request("POST", `/api/workspaces/${workspaceId}/tasks`, input);
  }
  updateTask(id: string, patch: Partial<TaskInput>): Promise<TaskDto> {
    return this.request("PATCH", `/api/tasks/${id}`, patch);
  }
  moveTask(id: string, status: TaskStatus, beforeId: string | null): Promise<TaskDto> {
    return this.request("POST", `/api/tasks/${id}/move`, { status, beforeId });
  }
  deleteTask(id: string): Promise<void> {
    return this.request("DELETE", `/api/tasks/${id}`);
  }

  // ------------------------------------------------- notifications/search

  notifications(opts: { unread?: boolean; cursor?: string } = {}): Promise<Page<NotificationDto> & { unreadCount: number }> {
    const params = new URLSearchParams({ limit: "20" });
    if (opts.unread) params.set("unread", "true");
    if (opts.cursor) params.set("cursor", opts.cursor);
    return this.request("GET", `/api/notifications?${params.toString()}`);
  }
  markNotificationRead(id: string): Promise<{ unreadCount: number }> {
    return this.request("POST", `/api/notifications/${id}/read`);
  }
  markAllNotificationsRead(): Promise<{ unreadCount: number }> {
    return this.request("POST", "/api/notifications/read-all");
  }
  search(q: string, opts: { workspaceId?: string; types?: string[] } = {}): Promise<SearchHit[]> {
    const params = new URLSearchParams({ q, limit: "30" });
    if (opts.workspaceId) params.set("workspaceId", opts.workspaceId);
    if (opts.types?.length) params.set("types", opts.types.join(","));
    return this.request("GET", `/api/search?${params.toString()}`);
  }
}

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.fieldMessage ?? err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong";
}
