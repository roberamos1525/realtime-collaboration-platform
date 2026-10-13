import { notificationQuerySchema, searchQuerySchema } from "@rcp/shared";
import type { Services } from "../../services/index.js";
import type { Router } from "../router.js";
import { idParam } from "./workspaces.js";

/** Notifications and search: per-user, cross-workspace endpoints. */
export function registerInboxRoutes(router: Router, services: Services): void {
  const { notifications, search } = services;

  router.get("/api/notifications", (ctx) => {
    const q = ctx.parseQuery(notificationQuerySchema);
    return notifications.list(ctx.userId, { limit: q.limit, unreadOnly: q.unread, ...(q.cursor ? { cursor: q.cursor } : {}) });
  });

  router.get("/api/notifications/unread-count", (ctx) => ({ unreadCount: notifications.unreadCount(ctx.userId) }));

  router.post("/api/notifications/read-all", (ctx) => notifications.markAllRead(ctx.userId));

  router.post("/api/notifications/:id/read", (ctx) => notifications.markRead(ctx.userId, idParam(ctx, "id")));

  router.post("/api/notifications/:id/unread", (ctx) => notifications.markUnread(ctx.userId, idParam(ctx, "id")));

  router.get("/api/search", (ctx) => {
    const q = ctx.parseQuery(searchQuerySchema);
    return search.search(ctx.userId, { q: q.q, workspaceId: q.workspaceId, types: q.types, limit: q.limit });
  });
}
