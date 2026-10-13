import { RgaDocument, excerpt, type DocumentDetailDto, type DocumentDto, type VersionDetailDto, type VersionDto } from "@rcp/shared";
import { notFound } from "../core/errors.js";
import { iso, newId } from "../core/util.js";
import type { DocumentRecord, VersionRecord } from "../repositories/documents.js";
import { toPublicUser } from "../repositories/users.js";
import type { ActivityService } from "./activity-service.js";
import type { AccessControl, ServiceDeps } from "./context.js";
import type { DocSessionManager } from "./doc-sessions.js";
import type { NotificationService } from "./notification-service.js";

function toDto(d: DocumentRecord): DocumentDto {
  return {
    id: d.id,
    workspaceId: d.workspaceId,
    title: d.title,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    excerpt: excerpt(d.content, 160),
  };
}

/** Document metadata, version snapshots and restore. */
export class DocumentService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly access: AccessControl,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationService,
    private readonly sessions: DocSessionManager,
  ) {}

  list(userId: string, workspaceId: string): DocumentDto[] {
    this.access.requireWorkspace(userId, workspaceId, "document.read");
    return this.deps.repos.documents.listByWorkspace(workspaceId).map((d) => {
      const live = this.sessions.peek(d.id);
      return live ? live.toDto() : toDto(d);
    });
  }

  create(userId: string, workspaceId: string, input: { title: string; content: string }): DocumentDetailDto {
    const { role } = this.access.requireWorkspace(userId, workspaceId, "document.create");
    const now = iso(this.deps.clock.now());
    const record: DocumentRecord = {
      id: newId("doc"),
      workspaceId,
      title: input.title,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
      content: input.content,
    };
    const crdt = RgaDocument.fromText(input.content, "init");
    this.deps.repos.documents.insert(record, JSON.stringify(crdt.snapshot()));
    this.activity.record({ workspaceId, documentId: record.id, actorId: userId, verb: "document.created", targetType: "document", targetId: record.id, meta: { title: record.title } });
    this.deps.events.emit({ type: "document.upserted", document: toDto(record) });
    this.deps.events.emit({ type: "document.content", documentId: record.id, workspaceId, title: record.title, content: record.content });
    return { ...toDto(record), text: record.content, headSeq: 0, role };
  }

  get(userId: string, documentId: string): DocumentDetailDto {
    const { document, role } = this.access.requireDocument(userId, documentId, "document.read");
    const { text, headSeq } = this.sessions.currentText(documentId);
    const live = this.sessions.peek(documentId);
    return { ...(live ? live.toDto() : toDto(document)), text, headSeq, role };
  }

  rename(userId: string, documentId: string, title: string): DocumentDto {
    const { document } = this.access.requireDocument(userId, documentId, "document.rename");
    const now = iso(this.deps.clock.now());
    this.deps.repos.documents.rename(documentId, title, now);
    this.sessions.setTitle(documentId, title, now);
    const updated = { ...document, title, updatedAt: now };
    this.activity.record({
      workspaceId: document.workspaceId,
      documentId,
      actorId: userId,
      verb: "document.renamed",
      targetType: "document",
      targetId: documentId,
      meta: { from: document.title, to: title },
    });
    const dto = this.sessions.peek(documentId)?.toDto() ?? toDto(updated);
    this.deps.events.emit({ type: "document.upserted", document: dto });
    const { text } = this.sessions.currentText(documentId);
    this.deps.events.emit({ type: "document.content", documentId, workspaceId: document.workspaceId, title, content: text });
    return dto;
  }

  delete(userId: string, documentId: string): void {
    const { document } = this.access.requireDocument(userId, documentId, "document.delete");
    this.deps.repos.documents.softDelete(documentId, iso(this.deps.clock.now()));
    this.sessions.drop(documentId);
    this.activity.record({
      workspaceId: document.workspaceId,
      documentId,
      actorId: userId,
      verb: "document.deleted",
      targetType: "document",
      targetId: documentId,
      meta: { title: document.title },
    });
    this.deps.events.emit({ type: "document.deleted", documentId, workspaceId: document.workspaceId });
  }

  listVersions(userId: string, documentId: string): VersionDto[] {
    this.access.requireDocument(userId, documentId, "document.read");
    return this.toVersionDtos(this.deps.repos.documents.listVersions(documentId));
  }

  getVersion(userId: string, documentId: string, versionId: string): VersionDetailDto {
    this.access.requireDocument(userId, documentId, "document.read");
    const version = this.deps.repos.documents.findVersion(documentId, versionId);
    if (!version) throw notFound("version");
    return { ...(this.toVersionDtos([version])[0] as VersionDto), text: version.content };
  }

  createVersion(userId: string, documentId: string, label: string): VersionDto {
    const { document } = this.access.requireDocument(userId, documentId, "version.create");
    const version = this.snapshotVersion(documentId, label, userId);
    this.activity.record({
      workspaceId: document.workspaceId,
      documentId,
      actorId: userId,
      verb: "version.created",
      targetType: "version",
      targetId: version.id,
      meta: { label },
    });
    return this.toVersionDtos([version])[0] as VersionDto;
  }

  /**
   * Restores a version by diffing the live text against it and applying the
   * result as CRDT operations, so connected editors converge without
   * reloading. The pre-restore state is saved as a version first.
   */
  restoreVersion(userId: string, documentId: string, versionId: string): DocumentDetailDto {
    const { document } = this.access.requireDocument(userId, documentId, "version.restore");
    const version = this.deps.repos.documents.findVersion(documentId, versionId);
    if (!version) throw notFound("version");
    this.snapshotVersion(documentId, `Before restoring “${version.label}”`, userId);
    const ops = this.sessions.replaceText(documentId, version.content, userId);
    this.activity.record({
      workspaceId: document.workspaceId,
      documentId,
      actorId: userId,
      verb: "version.restored",
      targetType: "version",
      targetId: versionId,
      meta: { label: version.label, operations: ops.length },
    });
    if (document.createdBy !== userId) {
      this.notifications.notify({
        userId: document.createdBy,
        kind: "document_restored",
        title: `“${document.title}” was restored`,
        body: `Restored to version “${version.label}”`,
        actorId: userId,
        workspaceId: document.workspaceId,
        documentId,
        entityId: versionId,
      });
    }
    return this.get(userId, documentId);
  }

  private snapshotVersion(documentId: string, label: string, userId: string): VersionRecord {
    const { text, headSeq } = this.sessions.currentText(documentId);
    const version: VersionRecord = {
      id: newId("ver"),
      documentId,
      label,
      content: text,
      seq: headSeq,
      createdBy: userId,
      createdAt: iso(this.deps.clock.now()),
    };
    this.deps.repos.documents.insertVersion(version);
    return version;
  }

  private toVersionDtos(rows: VersionRecord[]): VersionDto[] {
    const users = this.deps.repos.users.findManyByIds(rows.map((r) => r.createdBy).filter((id): id is string => id !== null));
    return rows.map((r) => {
      const author = r.createdBy ? users.get(r.createdBy) : undefined;
      return {
        id: r.id,
        documentId: r.documentId,
        label: r.label,
        seq: r.seq,
        length: r.content.length,
        createdBy: author ? toPublicUser(author) : null,
        createdAt: r.createdAt,
      };
    });
  }
}
