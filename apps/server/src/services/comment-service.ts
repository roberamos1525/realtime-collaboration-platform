import { can, excerpt, extractMentions, type CommentAnchor, type CommentDto } from "@rcp/shared";
import { badRequest, forbidden, notFound } from "../core/errors.js";
import { iso, newId } from "../core/util.js";
import type { CommentRecord } from "../repositories/comments.js";
import { toPublicUser } from "../repositories/users.js";
import type { ActivityService } from "./activity-service.js";
import type { AccessControl, ServiceDeps } from "./context.js";
import type { DocSessionManager } from "./doc-sessions.js";
import type { NotificationService } from "./notification-service.js";

export interface CreateCommentInput {
  readonly body: string;
  readonly anchor?: CommentAnchor | undefined;
  readonly parentId?: string | undefined;
}

/**
 * Threaded comments anchored to CRDT element ids. Anchors survive concurrent
 * edits because they reference character identities rather than offsets; the
 * referenced tombstones are retained during garbage collection.
 */
export class CommentService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly access: AccessControl,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationService,
    private readonly sessions: DocSessionManager,
  ) {}

  list(userId: string, documentId: string): CommentDto[] {
    this.access.requireDocument(userId, documentId, "comment.read");
    return this.toDtos(this.deps.repos.comments.listByDocument(documentId));
  }

  create(userId: string, documentId: string, input: CreateCommentInput): CommentDto {
    const { document } = this.access.requireDocument(userId, documentId, "comment.create");
    let parentId: string | null = null;
    if (input.parentId) {
      const parent = this.deps.repos.comments.findById(input.parentId);
      if (!parent || parent.documentId !== documentId) throw notFound("parent comment");
      // Threads are one level deep: replies to replies attach to the root.
      parentId = parent.parentId ?? parent.id;
    }
    if (input.anchor) {
      const session = this.sessions.get(documentId);
      if (!session.doc.hasElement(input.anchor.start) || !session.doc.hasElement(input.anchor.end)) {
        throw badRequest("comment anchor references text that does not exist");
      }
      const start = session.doc.resolveAnchor(input.anchor.start);
      const end = session.doc.resolveAnchor(input.anchor.end);
      if (start === null || end === null || end < start) throw badRequest("comment anchor range is invalid");
    }
    const now = iso(this.deps.clock.now());
    const record: CommentRecord = {
      id: newId("cmt"),
      documentId,
      workspaceId: document.workspaceId,
      parentId,
      authorId: userId,
      body: input.body,
      anchorStart: input.anchor?.start ?? null,
      anchorEnd: input.anchor?.end ?? null,
      anchorQuote: input.anchor?.quote ?? null,
      resolvedAt: null,
      resolvedBy: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.repos.comments.insert(record);
    this.activity.record({
      workspaceId: document.workspaceId,
      documentId,
      actorId: userId,
      verb: parentId ? "comment.replied" : "comment.created",
      targetType: "comment",
      targetId: record.id,
      meta: { excerpt: excerpt(record.body, 80), document: document.title },
    });
    const author = this.deps.repos.users.findById(userId);
    const actorName = author?.displayName ?? "Someone";
    const mentioned = this.notifyMentions(record, actorName, document.title);
    if (parentId) {
      for (const participant of this.deps.repos.comments.threadParticipants(parentId)) {
        if (mentioned.has(participant)) continue;
        this.notifications.notify({
          userId: participant,
          kind: "comment_reply",
          title: `${actorName} replied in “${document.title}”`,
          body: excerpt(record.body, 140),
          actorId: userId,
          workspaceId: document.workspaceId,
          documentId,
          entityId: record.id,
        });
      }
    }
    return this.emit(record);
  }

  update(userId: string, commentId: string, body: string): CommentDto {
    const comment = this.requireComment(userId, commentId);
    if (comment.authorId !== userId) throw forbidden("only the author can edit a comment");
    this.deps.repos.comments.updateBody(commentId, body, iso(this.deps.clock.now()));
    const updated = this.deps.repos.comments.findById(commentId) as CommentRecord;
    const document = this.deps.repos.documents.findById(comment.documentId);
    const author = this.deps.repos.users.findById(userId);
    // Only newly added mentions are notified on edit.
    const before = new Set(extractMentions(comment.body));
    this.notifyMentions(updated, author?.displayName ?? "Someone", document?.title ?? "a document", before);
    return this.emit(updated);
  }

  setResolved(userId: string, commentId: string, resolved: boolean): CommentDto {
    const comment = this.requireComment(userId, commentId);
    if (comment.parentId) throw badRequest("only top-level comments can be resolved");
    const role = this.access.roleIn(comment.workspaceId, userId);
    const isAuthor = comment.authorId === userId && can(role, "comment.create");
    if (!isAuthor && !can(role, "comment.resolve")) throw forbidden("you cannot resolve this comment");
    if (Boolean(comment.resolvedAt) === resolved) return this.toDtos([comment])[0] as CommentDto;
    this.deps.repos.comments.setResolved(commentId, resolved ? userId : null, iso(this.deps.clock.now()));
    this.activity.record({
      workspaceId: comment.workspaceId,
      documentId: comment.documentId,
      actorId: userId,
      verb: resolved ? "comment.resolved" : "comment.reopened",
      targetType: "comment",
      targetId: commentId,
      meta: { excerpt: excerpt(comment.body, 80) },
    });
    return this.emit(this.deps.repos.comments.findById(commentId) as CommentRecord);
  }

  delete(userId: string, commentId: string): void {
    const comment = this.requireComment(userId, commentId);
    const role = this.access.roleIn(comment.workspaceId, userId);
    if (comment.authorId !== userId && !can(role, "comment.moderate")) throw forbidden("you cannot delete this comment");
    const removed = this.deps.repos.comments.delete(commentId);
    this.activity.record({
      workspaceId: comment.workspaceId,
      documentId: comment.documentId,
      actorId: userId,
      verb: "comment.deleted",
      targetType: "comment",
      targetId: commentId,
      meta: { replies: removed.length - 1 },
    });
    for (const id of removed) {
      this.deps.events.emit({ type: "comment.deleted", commentId: id, documentId: comment.documentId, workspaceId: comment.workspaceId });
    }
  }

  private requireComment(userId: string, commentId: string): CommentRecord {
    const comment = this.deps.repos.comments.findById(commentId);
    if (!comment || !this.access.roleIn(comment.workspaceId, userId)) throw notFound("comment");
    this.access.requireDocument(userId, comment.documentId, "comment.read");
    return comment;
  }

  /** Notifies workspace members mentioned in the comment; returns their ids. */
  private notifyMentions(comment: CommentRecord, actorName: string, documentTitle: string, skip = new Set<string>()): Set<string> {
    const names = extractMentions(comment.body).filter((n) => !skip.has(n));
    const notified = new Set<string>();
    for (const user of this.deps.repos.users.findByUsernames(names)) {
      if (!this.access.roleIn(comment.workspaceId, user.id)) continue;
      const n = this.notifications.notify({
        userId: user.id,
        kind: "mention",
        title: `${actorName} mentioned you in “${documentTitle}”`,
        body: excerpt(comment.body, 140),
        actorId: comment.authorId,
        workspaceId: comment.workspaceId,
        documentId: comment.documentId,
        entityId: comment.id,
      });
      if (n) notified.add(user.id);
    }
    return notified;
  }

  private emit(record: CommentRecord): CommentDto {
    const dto = this.toDtos([record])[0] as CommentDto;
    this.deps.events.emit({ type: "comment.upserted", comment: dto });
    return dto;
  }

  private toDtos(rows: CommentRecord[]): CommentDto[] {
    const users = this.deps.repos.users.findManyByIds(rows.map((r) => r.authorId).filter((id): id is string => id !== null));
    return rows.map((r) => {
      const author = r.authorId ? users.get(r.authorId) : undefined;
      return {
        id: r.id,
        documentId: r.documentId,
        workspaceId: r.workspaceId,
        parentId: r.parentId,
        author: author ? toPublicUser(author) : null,
        body: r.body,
        anchor: r.anchorStart && r.anchorEnd ? { start: r.anchorStart, end: r.anchorEnd, quote: r.anchorQuote ?? "" } : null,
        resolvedAt: r.resolvedAt,
        resolvedBy: r.resolvedBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }
}
