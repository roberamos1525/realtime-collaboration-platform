import type { ActivityDto, CommentDto, DocumentDto, NotificationDto, TaskDto } from "@rcp/shared";
import type { Logger } from "./logger.js";

/**
 * Domain events emitted by services after their database writes commit.
 * The realtime gateway and the search indexer subscribe to these, which keeps
 * services unaware of transport and indexing concerns.
 */
export type DomainEvent =
  | { readonly type: "document.upserted"; readonly document: DocumentDto }
  | { readonly type: "document.deleted"; readonly documentId: string; readonly workspaceId: string }
  | {
      readonly type: "document.content";
      readonly documentId: string;
      readonly workspaceId: string;
      readonly title: string;
      readonly content: string;
    }
  | { readonly type: "comment.upserted"; readonly comment: CommentDto }
  | { readonly type: "comment.deleted"; readonly commentId: string; readonly documentId: string; readonly workspaceId: string }
  | { readonly type: "task.upserted"; readonly task: TaskDto }
  | { readonly type: "task.deleted"; readonly taskId: string; readonly workspaceId: string }
  | { readonly type: "activity.created"; readonly activity: ActivityDto }
  | { readonly type: "notification.created"; readonly userId: string; readonly notification: NotificationDto; readonly unreadCount: number }
  | { readonly type: "membership.changed"; readonly workspaceId: string; readonly userId: string }
  | { readonly type: "workspace.deleted"; readonly workspaceId: string }
  | { readonly type: "session.revoked"; readonly sessionId: string };

export type DomainEventType = DomainEvent["type"];
type Listener<T extends DomainEventType> = (event: Extract<DomainEvent, { type: T }>) => void;

/** Synchronous, typed in-process event bus. Listener errors are isolated. */
export class EventBus {
  private readonly listeners = new Map<DomainEventType, Set<(event: DomainEvent) => void>>();

  constructor(private readonly logger?: Logger) {}

  on<T extends DomainEventType>(type: T, listener: Listener<T>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const wrapped = listener as (event: DomainEvent) => void;
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  emit(event: DomainEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (err) {
        this.logger?.error("event listener failed", { event: event.type, err });
      }
    }
  }

  listenerCount(type: DomainEventType): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}
