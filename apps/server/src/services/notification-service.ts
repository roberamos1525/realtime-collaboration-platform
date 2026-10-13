import type { NotificationDto, Page } from "@rcp/shared";
import { notFound } from "../core/errors.js";
import { decodeCursor, encodeCursor, iso, newId } from "../core/util.js";
import type { NotificationRecord } from "../repositories/notifications.js";
import { toPublicUser } from "../repositories/users.js";
import type { ServiceDeps } from "./context.js";

export interface NotifyInput {
  readonly userId: string;
  readonly kind: NotificationDto["kind"];
  readonly title: string;
  readonly body: string;
  readonly actorId: string | null;
  readonly workspaceId?: string | null;
  readonly documentId?: string | null;
  readonly entityId?: string | null;
}

/** Persisted in-app notifications, pushed live through the event bus. */
export class NotificationService {
  constructor(private readonly deps: ServiceDeps) {}

  /** Creates a notification unless the recipient is the actor. */
  notify(input: NotifyInput): NotificationDto | null {
    if (input.actorId !== null && input.actorId === input.userId) return null;
    const record: NotificationRecord = {
      id: newId("ntf"),
      userId: input.userId,
      workspaceId: input.workspaceId ?? null,
      documentId: input.documentId ?? null,
      entityId: input.entityId ?? null,
      kind: input.kind,
      title: input.title.slice(0, 200),
      body: input.body.slice(0, 500),
      actorId: input.actorId,
      readAt: null,
      createdAt: iso(this.deps.clock.now()),
    };
    this.deps.repos.notifications.insert(record);
    const dto = this.toDtos([record])[0] as NotificationDto;
    this.deps.metrics.notificationsSent.inc({ kind: input.kind });
    this.deps.events.emit({
      type: "notification.created",
      userId: input.userId,
      notification: dto,
      unreadCount: this.deps.repos.notifications.unreadCount(input.userId),
    });
    return dto;
  }

  list(userId: string, opts: { limit: number; unreadOnly: boolean; cursor?: string }): Page<NotificationDto> & { unreadCount: number } {
    const decoded = decodeCursor(opts.cursor);
    const before =
      decoded && typeof decoded[0] === "string" && typeof decoded[1] === "string" ? { createdAt: decoded[0], id: decoded[1] } : undefined;
    const rows = this.deps.repos.notifications.list(userId, { limit: opts.limit + 1, unreadOnly: opts.unreadOnly, ...(before ? { before } : {}) });
    const items = this.toDtos(rows.slice(0, opts.limit));
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > opts.limit && last ? encodeCursor([last.createdAt, last.id]) : null,
      unreadCount: this.deps.repos.notifications.unreadCount(userId),
    };
  }

  markRead(userId: string, id: string): { unreadCount: number } {
    const n = this.deps.repos.notifications.findById(id);
    if (!n || n.userId !== userId) throw notFound("notification");
    this.deps.repos.notifications.markRead(userId, id, iso(this.deps.clock.now()));
    return { unreadCount: this.deps.repos.notifications.unreadCount(userId) };
  }

  markUnread(userId: string, id: string): { unreadCount: number } {
    const n = this.deps.repos.notifications.findById(id);
    if (!n || n.userId !== userId) throw notFound("notification");
    this.deps.repos.notifications.markUnread(userId, id);
    return { unreadCount: this.deps.repos.notifications.unreadCount(userId) };
  }

  markAllRead(userId: string): { updated: number; unreadCount: number } {
    const updated = this.deps.repos.notifications.markAllRead(userId, iso(this.deps.clock.now()));
    return { updated, unreadCount: 0 };
  }

  unreadCount(userId: string): number {
    return this.deps.repos.notifications.unreadCount(userId);
  }

  private toDtos(rows: NotificationRecord[]): NotificationDto[] {
    const actors = this.deps.repos.users.findManyByIds(rows.map((r) => r.actorId).filter((id): id is string => id !== null));
    return rows.map((r) => {
      const actor = r.actorId ? actors.get(r.actorId) : undefined;
      return {
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        workspaceId: r.workspaceId,
        documentId: r.documentId,
        entityId: r.entityId,
        actor: actor ? toPublicUser(actor) : null,
        readAt: r.readAt,
        createdAt: r.createdAt,
      };
    });
  }
}
