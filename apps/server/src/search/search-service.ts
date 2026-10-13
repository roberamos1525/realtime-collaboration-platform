import type { SearchHit, SearchType } from "@rcp/shared";
import { notFound } from "../core/errors.js";
import type { ServiceDeps } from "../services/context.js";
import { InvertedIndex, buildSnippet } from "./inverted-index.js";

interface EntryMeta {
  readonly type: SearchType;
  readonly id: string;
  readonly workspaceId: string;
  readonly documentId: string | null;
  readonly title: string;
  readonly body: string;
  readonly updatedAt: string;
}

export interface SearchRequest {
  readonly q: string;
  readonly workspaceId?: string | undefined;
  readonly types: readonly SearchType[];
  readonly limit: number;
}

const key = (type: SearchType, id: string): string => `${type}:${id}`;

/**
 * Full-text search across documents, comments and tasks.
 *
 * The index is rebuilt from SQLite at startup and then kept current from
 * domain events. Every query is filtered by the caller's current
 * memberships, so revoked access takes effect immediately.
 */
export class SearchService {
  private readonly index = new InvertedIndex<EntryMeta>([
    { name: "title", weight: 3 },
    { name: "body", weight: 1 },
  ]);
  private readonly unsubscribers: Array<() => void> = [];

  constructor(private readonly deps: ServiceDeps) {
    deps.metrics.searchIndexSize.collect(() => this.index.size);
    const { events } = deps;
    this.unsubscribers.push(
      events.on("document.content", (e) => {
        const previousTitle = this.index.getMeta(key("document", e.documentId))?.title;
        const updatedAt = this.deps.repos.documents.findById(e.documentId)?.updatedAt ?? new Date(this.deps.clock.now()).toISOString();
        this.upsertDocument(e.documentId, e.workspaceId, e.title, e.content, updatedAt);
        if (previousTitle !== undefined && previousTitle !== e.title) this.retitleComments(e.documentId, e.title);
      }),
      events.on("document.deleted", (e) => {
        this.index.remove(key("document", e.documentId));
        this.index.removeWhere((m) => m.type === "comment" && m.documentId === e.documentId);
      }),
      events.on("comment.upserted", ({ comment }) => {
        const doc = this.index.getMeta(key("document", comment.documentId));
        this.upsertComment(comment.id, comment.workspaceId, comment.documentId, doc?.title ?? "document", comment.body, comment.updatedAt);
      }),
      events.on("comment.deleted", (e) => this.index.remove(key("comment", e.commentId))),
      events.on("task.upserted", ({ task }) =>
        this.upsertTask(task.id, task.workspaceId, task.title, task.description, task.labels, task.documentId, task.updatedAt),
      ),
      events.on("task.deleted", (e) => this.index.remove(key("task", e.taskId))),
      events.on("workspace.deleted", (e) => this.index.removeWhere((m) => m.workspaceId === e.workspaceId)),
    );
  }

  /** Rebuilds the whole index from the database. */
  rebuild(): { entries: number; ms: number } {
    const started = performance.now();
    const { documents, comments, tasks } = this.deps.repos;
    this.index.removeWhere(() => true);
    const titles = new Map<string, string>();
    for (const d of documents.listAll()) {
      titles.set(d.id, d.title);
      this.upsertDocument(d.id, d.workspaceId, d.title, d.content, d.updatedAt);
    }
    for (const c of comments.listAll()) {
      const title = titles.get(c.documentId);
      if (title !== undefined) this.upsertComment(c.id, c.workspaceId, c.documentId, title, c.body, c.updatedAt);
    }
    for (const t of tasks.listAll()) this.upsertTask(t.id, t.workspaceId, t.title, t.description, t.labels, t.documentId, t.updatedAt);
    return { entries: this.index.size, ms: Math.round(performance.now() - started) };
  }

  search(userId: string, request: SearchRequest): SearchHit[] {
    const roles = this.deps.repos.workspaces.rolesForUser(userId);
    if (request.workspaceId && !roles.has(request.workspaceId)) throw notFound("workspace");
    const types = new Set(request.types);
    const matches = this.index.search(request.q, {
      limit: request.limit,
      filter: (m) =>
        types.has(m.type) && roles.has(m.workspaceId) && (request.workspaceId === undefined || m.workspaceId === request.workspaceId),
    });
    this.deps.metrics.searchQueries.inc();
    return matches.map(({ meta, score, matched }) => {
      const snippet = buildSnippet(meta.body || meta.title, matched);
      return {
        type: meta.type,
        id: meta.id,
        workspaceId: meta.workspaceId,
        documentId: meta.documentId,
        title: meta.title,
        snippet: snippet.text,
        highlights: snippet.highlights,
        score: Math.round(score * 1000) / 1000,
        updatedAt: meta.updatedAt,
      };
    });
  }

  stats(): { entries: number; terms: number } {
    return { entries: this.index.size, terms: this.index.termCount };
  }

  close(): void {
    for (const off of this.unsubscribers) off();
  }

  private upsertDocument(id: string, workspaceId: string, title: string, content: string, updatedAt: string): void {
    this.index.upsert(key("document", id), { title, body: content }, { type: "document", id, workspaceId, documentId: id, title, body: content, updatedAt });
  }

  private upsertComment(id: string, workspaceId: string, documentId: string, docTitle: string, body: string, updatedAt: string): void {
    this.index.upsert(
      key("comment", id),
      { title: "", body },
      { type: "comment", id, workspaceId, documentId, title: `Comment on “${docTitle}”`, body, updatedAt },
    );
  }

  private retitleComments(documentId: string, docTitle: string): void {
    for (const c of this.deps.repos.comments.listByDocument(documentId)) {
      this.upsertComment(c.id, c.workspaceId, c.documentId, docTitle, c.body, c.updatedAt);
    }
  }

  private upsertTask(
    id: string,
    workspaceId: string,
    title: string,
    description: string,
    labels: readonly string[],
    documentId: string | null,
    updatedAt: string,
  ): void {
    const body = [description, labels.length ? `Labels: ${labels.join(", ")}` : ""].filter(Boolean).join("\n");
    this.index.upsert(key("task", id), { title, body }, { type: "task", id, workspaceId, documentId, title, body, updatedAt });
  }
}
