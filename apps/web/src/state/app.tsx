import type { NotificationDto, ServerMessage, UserDto } from "@rcp/shared";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ApiClient, errorMessage } from "../lib/api";
import { RealtimeClient, defaultSocketUrl, type ConnectionStatus } from "../lib/socket";
import { createStore, useStore, type Store } from "../lib/store";

export interface Toast {
  readonly id: number;
  readonly title: string;
  readonly body?: string;
  readonly tone: "info" | "error";
}

interface InboxState {
  readonly items: NotificationDto[];
  readonly unreadCount: number;
  readonly loaded: boolean;
}

interface AppServices {
  readonly api: ApiClient;
  readonly realtime: RealtimeClient;
  readonly inbox: Store<InboxState>;
  readonly toasts: Store<{ items: Toast[] }>;
  readonly connection: Store<{ status: ConnectionStatus }>;
}

const AppContext = createContext<AppServices | null>(null);

function createServices(): AppServices {
  const api = new ApiClient();
  const realtime = new RealtimeClient({
    url: defaultSocketUrl(),
    getToken: () => api.freshAccessToken(),
    onAuthLost: () => api.clearSession(),
  });
  return {
    api,
    realtime,
    inbox: createStore<InboxState>({ items: [], unreadCount: 0, loaded: false }),
    toasts: createStore<{ items: Toast[] }>({ items: [] }),
    connection: createStore<{ status: ConnectionStatus }>({ status: "idle" }),
  };
}

let toastId = 0;

export function pushToast(store: Store<{ items: Toast[] }>, toast: Omit<Toast, "id">): void {
  const id = ++toastId;
  store.set((s) => ({ items: [...s.items.slice(-3), { ...toast, id }] }));
  setTimeout(() => store.set((s) => ({ items: s.items.filter((t) => t.id !== id) })), 5000);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const services = useRef<AppServices | null>(null);
  services.current ??= createServices();
  const app = services.current;
  const session = useSyncExternalStore(
    (cb) => app.api.onSessionChange(cb),
    () => app.api.currentSession,
  );
  const userId = session?.user.id ?? null;

  useEffect(() => app.realtime.onStatus((status) => app.connection.set({ status })), [app]);

  useEffect(() => {
    if (!userId) {
      app.realtime.disconnect();
      app.inbox.set({ items: [], unreadCount: 0, loaded: false });
      return;
    }
    app.realtime.connect();
    let cancelled = false;
    app.api
      .notifications()
      .then((page) => {
        if (!cancelled) app.inbox.set({ items: page.items, unreadCount: page.unreadCount, loaded: true });
      })
      .catch((err: unknown) => pushToast(app.toasts, { title: "Could not load notifications", body: errorMessage(err), tone: "error" }));
    const off = app.realtime.on((msg: ServerMessage) => {
      if (msg.type !== "notification") return;
      app.inbox.set((s) => ({ ...s, items: [msg.notification, ...s.items].slice(0, 50), unreadCount: msg.unreadCount }));
      pushToast(app.toasts, { title: msg.notification.title, body: msg.notification.body, tone: "info" });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [app, userId]);

  return <AppContext.Provider value={app}>{children}</AppContext.Provider>;
}

export function useApp(): AppServices {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

export function useSessionUser(): UserDto | null {
  const { api } = useApp();
  const session = useSyncExternalStore(
    (cb) => api.onSessionChange(cb),
    () => api.currentSession,
  );
  return session?.user ?? null;
}

export function useInbox(): InboxState {
  const { inbox } = useApp();
  return useStore(inbox, (s) => s);
}

export function useConnectionStatus(): ConnectionStatus {
  const { connection } = useApp();
  return useStore(connection, (s) => s.status);
}

export function useToasts(): Toast[] {
  const { toasts } = useApp();
  return useStore(toasts, (s) => s.items);
}

/** Subscribes to realtime server messages for the component's lifetime. */
export function useRealtimeMessages(handler: (msg: ServerMessage) => void): void {
  const { realtime } = useApp();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => realtime.on((msg) => ref.current(msg)), [realtime]);
}

/** Keeps a workspace subscription open while mounted. */
export function useWorkspaceSubscription(workspaceId: string | null): void {
  const { realtime } = useApp();
  useEffect(() => (workspaceId ? realtime.retainWorkspace(workspaceId) : undefined), [realtime, workspaceId]);
}

export interface AsyncState<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  reload(): void;
  setData(update: (prev: T | null) => T | null): void;
}

/** Loads data for the given dependency key, exposing loading/error state. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader
      .current()
      .then((value) => {
        if (!cancelled) setDataState(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const setData = useCallback((update: (prev: T | null) => T | null) => setDataState(update), []);
  return { data, error, loading, reload, setData };
}
