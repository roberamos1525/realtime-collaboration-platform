import type { ActivityDto, Page } from "@rcp/shared";
import { iso } from "../core/util.js";
import type { ActivityRecord } from "../repositories/activity.js";
import { toPublicUser } from "../repositories/users.js";
import type { AccessControl, ServiceDeps } from "./context.js";

export interface ActivityInput {
  readonly workspaceId: string;
  readonly documentId?: string | null;
  readonly actorId: string | null;
  readonly verb: string;
  readonly targetType: "workspace" | "member" | "document" | "version" | "comment" | "task";
  readonly targetId?: string | null;
  readonly meta?: Record<string, unknown>;
}

/** Append-only audit/activity feed per workspace and per document. */
export class ActivityService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly access: AccessControl,
  ) {}

  record(input: ActivityInput): ActivityDto {
    const record = this.deps.repos.activity.insert({
      workspaceId: input.workspaceId,
      documentId: input.documentId ?? null,
      actorId: input.actorId,
      verb: input.verb,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      meta: input.meta ?? {},
      createdAt: iso(this.deps.clock.now()),
    });
    const dto = this.toDtos([record])[0] as ActivityDto;
    this.deps.events.emit({ type: "activity.created", activity: dto });
    return dto;
  }

  listForWorkspace(userId: string, workspaceId: string, limit: number, cursor?: string): Page<ActivityDto> {
    this.access.requireWorkspace(userId, workspaceId, "activity.read");
    const rows = this.deps.repos.activity.listForWorkspace(workspaceId, limit + 1, parseCursor(cursor));
    return this.page(rows, limit);
  }

  listForDocument(userId: string, documentId: string, limit: number, cursor?: string): Page<ActivityDto> {
    this.access.requireDocument(userId, documentId, "activity.read");
    const rows = this.deps.repos.activity.listForDocument(documentId, limit + 1, parseCursor(cursor));
    return this.page(rows, limit);
  }

  private page(rows: ActivityRecord[], limit: number): Page<ActivityDto> {
    const items = this.toDtos(rows.slice(0, limit));
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? String(last.id) : null };
  }

  private toDtos(rows: ActivityRecord[]): ActivityDto[] {
    const users = this.deps.repos.users.findManyByIds(rows.map((r) => r.actorId).filter((id): id is string => id !== null));
    return rows.map((r) => {
      const actor = r.actorId ? users.get(r.actorId) : undefined;
      return {
        id: r.id,
        workspaceId: r.workspaceId,
        documentId: r.documentId,
        actor: actor ? toPublicUser(actor) : null,
        verb: r.verb,
        targetType: r.targetType,
        targetId: r.targetId,
        meta: r.meta,
        createdAt: r.createdAt,
      };
    });
  }
}

function parseCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  const n = Number(cursor);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
