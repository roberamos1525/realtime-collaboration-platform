import { createHash } from "node:crypto";
import type { Database } from "./database.js";

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Ordered schema migrations. Applied migrations are recorded with a checksum;
 * editing an applied migration is detected and refused at startup.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL UNIQUE,
  previous_hash TEXT,
  user_agent TEXT,
  ip TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_previous ON sessions(previous_hash);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer','commenter','editor','admin','owner')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  snapshot TEXT NOT NULL,
  snapshot_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT ''
);
CREATE INDEX documents_workspace ON documents(workspace_id, updated_at);

CREATE TABLE document_ops (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  user_id TEXT,
  op TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, seq)
) WITHOUT ROWID;

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX document_versions_doc ON document_versions(document_id, created_at);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  anchor_start TEXT,
  anchor_end TEXT,
  anchor_quote TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id TEXT,
  entity_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC, id DESC);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id TEXT,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  verb TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX activity_workspace ON activity(workspace_id, id DESC);
CREATE INDEX activity_document ON activity(document_id, id DESC);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('todo','in_progress','review','done')),
  priority TEXT NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  position REAL NOT NULL,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_board ON tasks(workspace_id, status, position);
`,
  },
  {
    id: 2,
    name: "login_tracking_and_comment_index",
    sql: `
ALTER TABLE users ADD COLUMN last_login_at TEXT;
CREATE INDEX comments_document ON comments(document_id, created_at);
CREATE INDEX tasks_assignee ON tasks(assignee_id);
`,
  },
];

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 16);
}

export interface MigrationReport {
  readonly applied: string[];
  readonly current: number;
}

/** Applies all pending migrations, each in its own transaction. */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): MigrationReport {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const done = new Map(
    db.all<{ id: number; name: string; checksum: string }>("SELECT id, name, checksum FROM schema_migrations").map((r) => [r.id, r]),
  );
  const ids = migrations.map((m) => m.id);
  if (ids.some((id, i) => i > 0 && id <= (ids[i - 1] as number))) throw new MigrationError("migrations must be strictly ordered");
  for (const [id] of done) {
    if (!migrations.some((m) => m.id === id)) throw new MigrationError(`database has unknown migration ${id}; refusing to run older code`);
  }
  const applied: string[] = [];
  for (const m of migrations) {
    const sum = checksum(m.sql);
    const existing = done.get(m.id);
    if (existing) {
      if (existing.checksum !== sum) throw new MigrationError(`migration ${m.id} (${m.name}) was modified after being applied`);
      continue;
    }
    db.transaction(() => {
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)", [
        m.id,
        m.name,
        sum,
        new Date().toISOString(),
      ]);
    });
    applied.push(`${m.id}_${m.name}`);
  }
  return { applied, current: migrations.at(-1)?.id ?? 0 };
}
