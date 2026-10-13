# Data model

SQLite through `node:sqlite` (`apps/server/src/db`). Foreign keys are enforced. File databases use WAL with
`synchronous=NORMAL` and a 5 s busy timeout. Timestamps are ISO-8601 UTC strings, and ids are prefixed random
base62 strings (`usr_`, `ses_`, `ws_`, `doc_`, `ver_`, `cmt_`, `tsk_`, `ntf_`).

## Migrations

`schema_migrations(id, name, checksum, applied_at)` records applied migrations. At startup `migrate()`:

1. refuses databases that contain migrations unknown to the running code (a downgrade);
2. refuses applied migrations whose SQL checksum changed;
3. applies pending migrations in order, each inside its own transaction.

| id | name | contents |
| --- | --- | --- |
| 1 | `initial_schema` | all tables below |
| 2 | `login_tracking_and_comment_index` | `users.last_login_at`, `comments_document`, `tasks_assignee` indexes |

## Tables

```
users ──< sessions
  │
  ├──< memberships >── workspaces ──< documents ──< document_ops
  │                        │              ├──< document_versions
  │                        │              └──< comments (parent_id → comments)
  │                        ├──< tasks (assignee_id → users, document_id → documents)
  │                        └──< activity
  └──< notifications
```

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | `email UNIQUE`, `username UNIQUE COLLATE NOCASE`, `password_hash` | `scrypt$N$r$p$salt$hash` |
| `sessions` | `refresh_hash UNIQUE`, `previous_hash`, `expires_at`, `revoked_at`, `revoke_reason` | `previous_hash` enables refresh-token reuse detection |
| `workspaces` | `slug UNIQUE`, `owner_id` | slug is derived from the name, with `-2`, `-3` … on collision |
| `memberships` | PK `(workspace_id, user_id)`, `role CHECK (…)` | cascade on workspace or user deletion |
| `documents` | `snapshot` (JSON RGA snapshot), `snapshot_seq`, `head_seq`, `content`, `deleted_at` | `content` is a plain-text cache for listings, search and offline reads |
| `document_ops` | PK `(document_id, seq)` `WITHOUT ROWID`, `op` (JSON), `user_id` | rows with `seq ≤ snapshot_seq` are deleted at compaction |
| `document_versions` | `content`, `seq`, `label`, `created_by` | full-text copies |
| `comments` | `parent_id`, `anchor_start`, `anchor_end`, `anchor_quote`, `resolved_at`, `resolved_by` | anchors are CRDT element keys; replies cascade |
| `tasks` | `status CHECK`, `priority CHECK`, `position REAL`, `labels` (JSON array), `due_date` | index `(workspace_id, status, position)` |
| `notifications` | `user_id`, `kind`, `read_at`, `actor_id`, `entity_id` | index `(user_id, created_at DESC, id DESC)` for keyset paging |
| `activity` | `INTEGER PRIMARY KEY AUTOINCREMENT`, `verb`, `target_type`, `meta` (JSON) | id doubles as the pagination cursor |

## Document state lifecycle

```
create ──▶ documents.snapshot = RGA.fromText(content, "init"), head_seq = 0
edit   ──▶ INSERT document_ops(seq = head_seq + 1); UPDATE head_seq            (per op, in one transaction)
compact ─▶ UPDATE snapshot, snapshot_seq = head_seq, content; DELETE ops ≤ snapshot_seq   (one transaction)
load   ──▶ RGA.fromSnapshot(snapshot) then replay ops with seq > snapshot_seq
```

Compaction runs every `snapshotEveryOps` integrated ops, when an idle document is evicted, on `compact` from the
CLI and on graceful shutdown. If the process dies between compactions, the op log still holds every acknowledged op.
`content` is also refreshed by a debounced flush (`contentFlushMs`) that feeds search and document listings.

## Task ordering

Positions are floats spaced 1024 apart. Moving a task before another puts it at the midpoint of its new neighbours,
so only one row changes. When neighbours get closer than 1e-6, the column is renumbered (`1024, 2048, …`) in one
transaction before the midpoint is computed.

## Pagination

- Activity: `WHERE id < :cursor ORDER BY id DESC LIMIT n+1`, with `nextCursor = last id`.
- Notifications: `(created_at, id) < (:at, :id)` with a base64url JSON cursor.
- Both fetch `limit + 1` rows to know whether another page exists.
