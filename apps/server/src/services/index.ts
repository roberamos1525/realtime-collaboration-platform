import { AuthService } from "../auth/auth-service.js";
import { SearchService } from "../search/search-service.js";
import { ActivityService } from "./activity-service.js";
import { CommentService } from "./comment-service.js";
import { AccessControl, type ServiceDeps } from "./context.js";
import { DocSessionManager } from "./doc-sessions.js";
import { DocumentService } from "./document-service.js";
import { NotificationService } from "./notification-service.js";
import { TaskService } from "./task-service.js";
import { WorkspaceService } from "./workspace-service.js";

/** Wires every service together (constructor injection, no globals). */
export function createServices(deps: ServiceDeps) {
  const access = new AccessControl(deps.repos);
  const activity = new ActivityService(deps, access);
  const notifications = new NotificationService(deps);
  const sessions = new DocSessionManager(deps, activity);
  const tasks = new TaskService(deps, access, activity, notifications);
  const workspaces = new WorkspaceService(deps, access, activity, notifications, tasks);
  const documents = new DocumentService(deps, access, activity, notifications, sessions);
  const comments = new CommentService(deps, access, activity, notifications, sessions);
  const auth = new AuthService(deps);
  const search = new SearchService(deps);
  return { access, activity, notifications, sessions, tasks, workspaces, documents, comments, auth, search };
}

export type Services = ReturnType<typeof createServices>;
