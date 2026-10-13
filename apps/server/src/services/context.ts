import { can, type Action, type Role } from "@rcp/shared";
import type { AppConfig } from "../core/config.js";
import { forbidden, notFound } from "../core/errors.js";
import type { EventBus } from "../core/events.js";
import type { Logger } from "../core/logger.js";
import type { AppMetrics } from "../core/metrics.js";
import type { Clock } from "../core/util.js";
import type { Database } from "../db/database.js";
import type { Repositories } from "../repositories/index.js";
import type { DocumentRecord } from "../repositories/documents.js";
import type { WorkspaceRecord } from "../repositories/workspaces.js";

/** Shared dependencies handed to every service. */
export interface ServiceDeps {
  readonly config: AppConfig;
  readonly db: Database;
  readonly repos: Repositories;
  readonly events: EventBus;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: AppMetrics;
}

/**
 * Central authorization checks. Non-members get `not_found` rather than
 * `forbidden` so workspace and document ids cannot be probed.
 */
export class AccessControl {
  constructor(private readonly repos: Repositories) {}

  roleIn(workspaceId: string, userId: string): Role | null {
    return this.repos.workspaces.roleOf(workspaceId, userId);
  }

  requireWorkspace(userId: string, workspaceId: string, action: Action): { workspace: WorkspaceRecord; role: Role } {
    const workspace = this.repos.workspaces.findById(workspaceId);
    const role = workspace ? this.roleIn(workspaceId, userId) : null;
    if (!workspace || !role) throw notFound("workspace");
    if (!can(role, action)) throw forbidden(`your role (${role}) cannot perform ${action}`);
    return { workspace, role };
  }

  requireDocument(userId: string, documentId: string, action: Action): { document: DocumentRecord; role: Role } {
    const document = this.repos.documents.findById(documentId);
    const role = document ? this.roleIn(document.workspaceId, userId) : null;
    if (!document || !role) throw notFound("document");
    if (!can(role, action)) throw forbidden(`your role (${role}) cannot perform ${action}`);
    return { document, role };
  }
}
