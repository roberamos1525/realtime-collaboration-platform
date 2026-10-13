import type { NotificationDto } from "@rcp/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "../lib/api";
import { relativeTime } from "../lib/format";
import { navigate, queryParam, useLocation } from "../lib/router";
import { pushToast, useApp, useConnectionStatus, useInbox, useSessionUser } from "../state/app";
import { Avatar, Link, Toasts } from "./ui";

function notificationTarget(n: NotificationDto): string {
  if (n.documentId) return `/d/${n.documentId}`;
  if (n.kind === "task_assigned" && n.workspaceId) return `/w/${n.workspaceId}/tasks`;
  if (n.workspaceId) return `/w/${n.workspaceId}`;
  return "/";
}

function NotificationsMenu() {
  const { api, inbox, toasts } = useApp();
  const { items, unreadCount } = useInbox();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const markRead = async (n: NotificationDto) => {
    if (!n.readAt) {
      try {
        const { unreadCount: count } = await api.markNotificationRead(n.id);
        inbox.set((s) => ({
          ...s,
          unreadCount: count,
          items: s.items.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)),
        }));
      } catch (err) {
        pushToast(toasts, { title: "Could not update notification", body: errorMessage(err), tone: "error" });
      }
    }
    setOpen(false);
    navigate(notificationTarget(n));
  };

  const markAll = async () => {
    try {
      await api.markAllNotificationsRead();
      const now = new Date().toISOString();
      inbox.set((s) => ({ ...s, unreadCount: 0, items: s.items.map((x) => ({ ...x, readAt: x.readAt ?? now })) }));
    } catch (err) {
      pushToast(toasts, { title: "Could not mark notifications read", body: errorMessage(err), tone: "error" });
    }
  };

  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="icon-button bell"
        aria-label={`Notifications (${unreadCount} unread)`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M12 3a6 6 0 0 0-6 6v3.5L4.5 15v1h15v-1L18 12.5V9a6 6 0 0 0-6-6Zm0 18a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 21Z" fill="currentColor" />
        </svg>
        {unreadCount > 0 && <span className="count">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>
      {open && (
        <div className="menu-panel notifications-panel">
          <div className="menu-header">
            <strong>Notifications</strong>
            <button type="button" className="link-button" onClick={markAll} disabled={unreadCount === 0}>
              Mark all read
            </button>
          </div>
          {items.length === 0 && <p className="muted pad">You're all caught up.</p>}
          <ul>
            {items.map((n) => (
              <li key={n.id}>
                <button type="button" className={`notification${n.readAt ? "" : " unread"}`} onClick={() => void markRead(n)}>
                  {n.actor ? <Avatar userId={n.actor.id} name={n.actor.displayName} size={26} /> : <span className="avatar-placeholder" />}
                  <span className="notification-text">
                    <strong>{n.title}</strong>
                    <span>{n.body}</span>
                    <time dateTime={n.createdAt}>{relativeTime(n.createdAt)}</time>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SearchBox() {
  const location = useLocation();
  const [value, setValue] = useState(() => queryParam(location, "q") ?? "");
  return (
    <form
      className="search-box"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) navigate(`/search?q=${encodeURIComponent(value.trim())}`);
      }}
    >
      <input type="search" placeholder="Search documents, comments, tasks…" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Search" />
    </form>
  );
}

function ConnectionIndicator() {
  const status = useConnectionStatus();
  const label = status === "open" ? "Live" : status === "reconnecting" ? "Reconnecting…" : status === "connecting" ? "Connecting…" : "Offline";
  return (
    <span className={`connection connection-${status}`} title={`Realtime connection: ${label}`}>
      <span className="dot" />
      <span className="connection-label">{label}</span>
    </span>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { api } = useApp();
  const user = useSessionUser();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Collab Space</span>
        </Link>
        <SearchBox />
        <div className="topbar-actions">
          <ConnectionIndicator />
          <NotificationsMenu />
          {user && (
            <div className="menu">
              <button type="button" className="user-button" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen}>
                <Avatar userId={user.id} name={user.displayName} />
                <span className="user-name">{user.displayName}</span>
              </button>
              {menuOpen && (
                <div className="menu-panel">
                  <div className="pad">
                    <strong>{user.displayName}</strong>
                    <div className="muted">@{user.username}</div>
                  </div>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      void api.logout().then(() => navigate("/login"));
                    }}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>
      <main className="content">{children}</main>
      <Toasts />
    </div>
  );
}
