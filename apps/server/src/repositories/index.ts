import type { Database } from "../db/database.js";
import { ActivityRepository } from "./activity.js";
import { CommentRepository } from "./comments.js";
import { DocumentRepository } from "./documents.js";
import { NotificationRepository } from "./notifications.js";
import { SessionRepository } from "./sessions.js";
import { TaskRepository } from "./tasks.js";
import { UserRepository } from "./users.js";
import { WorkspaceRepository } from "./workspaces.js";

export function createRepositories(db: Database) {
  return {
    users: new UserRepository(db),
    sessions: new SessionRepository(db),
    workspaces: new WorkspaceRepository(db),
    documents: new DocumentRepository(db),
    comments: new CommentRepository(db),
    tasks: new TaskRepository(db),
    notifications: new NotificationRepository(db),
    activity: new ActivityRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
