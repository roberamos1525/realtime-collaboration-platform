# API reference

Base URL: `http://<host>:<port>`. All REST endpoints live under `/api`, accept and return JSON, and (unless marked
*public*) require `Authorization: Bearer <accessToken>`. Ids are opaque strings such as `ws_…`, `doc_…`, `tsk_…`.

## Conventions

**Success**: `200`/`201` with `{ "data": <payload> }`, or `204 No Content`.

**Errors**: always

```json
{ "error": { "code": "validation_failed", "message": "request validation failed",
             "details": { "issues": [{ "path": "title", "message": "Too small: expected string to have >=1 characters" }] },
             "requestId": "req_x1Y2z3" } }
```

| code | status | meaning |
| --- | --- | --- |
| `bad_request` | 400 | Malformed JSON or other client error |
| `unauthenticated` | 401 | Missing/invalid token, revoked session, bad credentials |
| `token_expired` | 401 | Access token expired; call `/api/auth/refresh` |
| `forbidden` | 403 | Member, but the role is insufficient |
| `not_found` | 404 | Resource missing, **or the caller is not a member** (existence is hidden) |
| `method_not_allowed` | 405 | `Allow` header lists valid methods |
| `conflict` | 409 | Duplicate e-mail/username, already a member, … |
| `payload_too_large` | 413 | Body over `BODY_LIMIT_BYTES` (1 MiB default) |
| `unsupported_media_type` | 415 | Body without `Content-Type: application/json` |
| `validation_failed` | 422 | Schema validation failed; see `details.issues` |
| `rate_limited` | 429 | Token bucket empty; see `Retry-After` header |
| `internal` | 500 | Unexpected error (details are logged, not returned) |

Every response carries `X-Request-Id` (echoed from the request when it matches `[A-Za-z0-9._-]{1,64}`).
Paginated lists return `{ items, nextCursor }`. Pass `cursor=<nextCursor>` to continue (keyset pagination).

## Roles

`viewer < commenter < editor < admin < owner`.

| Action | Minimum role |
| --- | --- |
| Read workspace, members, documents, comments, tasks, activity; search | viewer |
| Create comments, resolve own threads | commenter |
| Create, edit and rename documents; save versions; create, update and move tasks; resolve any thread; delete own tasks | editor |
| Manage members below admin, delete documents and others' tasks and comments, restore versions, update workspace | admin |
| Grant or revoke admin, delete or transfer the workspace | owner |

## Platform

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/healthz` | *public*, liveness (not rate limited) |
| GET | `/readyz` | *public*, checks the database and reports session, realtime and search stats |
| GET | `/metrics` | Prometheus text. Requires `Bearer METRICS_TOKEN` when configured |

## Authentication

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/api/auth/register` *public* | `{ email, username, displayName, password }` (password ≥ 10 chars; username 3–32 of `[A-Za-z0-9_.-]`) | `201` `AuthResult` |
| POST | `/api/auth/login` *public* | `{ login, password }` (`login` = username or e-mail) | `AuthResult` |
| POST | `/api/auth/refresh` *public* | `{ refreshToken }` | `AuthResult` with a **new** refresh token. Reusing an old one revokes the session |
| POST | `/api/auth/logout` | `{}` | `204`, revokes the current session (open sockets close with 4010) |
| POST | `/api/auth/logout-all` | — | `{ revoked }` |
| POST | `/api/auth/password` | `{ currentPassword, newPassword }` | `{ otherSessionsRevoked }` |
| GET | `/api/auth/me` | — | `UserDto` |
| GET | `/api/users?q=` | `q` ≥ 2 chars | `PublicUser[]` (prefix match, max 10) |

`AuthResult = { user, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt }`. Auth endpoints
use a stricter per-IP rate limit (10-request burst, then 1 per 5 s by default).

## Workspaces and members

| Method | Path | Body / query | Role |
| --- | --- | --- | --- |
| GET | `/api/workspaces` | — | any user (own workspaces, with `role`, `memberCount`) |
| POST | `/api/workspaces` | `{ name, description? }` | any user (becomes owner) |
| GET | `/api/workspaces/:id` | — | viewer |
| PATCH | `/api/workspaces/:id` | `{ name?, description? }` | admin |
| DELETE | `/api/workspaces/:id` | — | owner |
| GET | `/api/workspaces/:id/members` | — | viewer |
| POST | `/api/workspaces/:id/members` | `{ identifier (username or e-mail), role? }` | admin (only the owner grants `admin`) |
| PATCH | `/api/workspaces/:id/members/:userId` | `{ role }` | admin, same rules |
| DELETE | `/api/workspaces/:id/members/:userId` | — | admin, or yourself to leave (the owner cannot leave) |
| POST | `/api/workspaces/:id/transfer` | `{ userId }` | owner (the previous owner becomes admin) |
| GET | `/api/workspaces/:id/activity` | `limit` (1–100), `cursor` | viewer |

## Documents and versions

| Method | Path | Body / query | Role |
| --- | --- | --- | --- |
| GET | `/api/workspaces/:id/documents` | — | viewer (`DocumentDto[]` with excerpts) |
| POST | `/api/workspaces/:id/documents` | `{ title, content? }` (≤ 500 000 chars) | editor |
| GET | `/api/documents/:id` | — | viewer, returns `{ …, text, headSeq, role }` |
| PATCH | `/api/documents/:id` | `{ title }` | editor |
| DELETE | `/api/documents/:id` | — | admin (soft delete; connected editors receive `doc.closed`) |
| GET | `/api/documents/:id/activity` | `limit`, `cursor` | viewer |
| GET | `/api/documents/:id/versions` | — | viewer |
| POST | `/api/documents/:id/versions` | `{ label }` | editor |
| GET | `/api/documents/:id/versions/:versionId` | — | viewer (includes `text`) |
| POST | `/api/documents/:id/versions/:versionId/restore` | — | admin. Saves the current text as a version, then applies the restore as live CRDT ops |

Document text is edited over the WebSocket protocol, not via REST.

## Comments

| Method | Path | Body | Role |
| --- | --- | --- | --- |
| GET | `/api/documents/:id/comments` | — | viewer |
| POST | `/api/documents/:id/comments` | `{ body, anchor?: { start, end, quote }, parentId? }` | commenter |
| PATCH | `/api/comments/:id` | `{ body }` | author |
| POST | `/api/comments/:id/resolve` · `/reopen` | — | editor, or the thread author |
| DELETE | `/api/comments/:id` | — | author or admin (replies are deleted too) |

`anchor.start` and `anchor.end` are CRDT element keys (`"<clock>@<site>"`) of the first and last selected
character, and must exist in the document. Replies cannot carry anchors, and a reply to a reply attaches to the
thread root. `@username` mentions of workspace members create `mention` notifications.

## Tasks

| Method | Path | Body / query | Role |
| --- | --- | --- | --- |
| GET | `/api/workspaces/:id/tasks` | `status?`, `assigneeId?`, `label?` | viewer |
| POST | `/api/workspaces/:id/tasks` | `{ title, description?, status?, priority?, assigneeId?, dueDate? (YYYY-MM-DD), labels?, documentId? }` | editor |
| GET | `/api/tasks/:id` | — | viewer |
| PATCH | `/api/tasks/:id` | any subset of the create fields (at least one) | editor |
| POST | `/api/tasks/:id/move` | `{ status, beforeId: string \| null }` | editor (`null` = end of column) |
| DELETE | `/api/tasks/:id` | — | admin, or an editor deleting a task they created |

`status ∈ todo | in_progress | review | done`, `priority ∈ low | medium | high | urgent`. Labels are lower-cased,
de-duplicated, at most 10. Assignees must be members. Assigning a task notifies the assignee.

## Notifications and search

| Method | Path | Query / body | Result |
| --- | --- | --- | --- |
| GET | `/api/notifications` | `unread=true`, `limit`, `cursor` | `{ items, nextCursor, unreadCount }` |
| GET | `/api/notifications/unread-count` | — | `{ unreadCount }` |
| POST | `/api/notifications/:id/read` · `/unread` | — | `{ unreadCount }` |
| POST | `/api/notifications/read-all` | — | `{ updated, unreadCount }` |
| GET | `/api/search` | `q` (1–200 chars), `types=document,comment,task`, `workspaceId?`, `limit` (≤ 50) | `SearchHit[]` |

Notification kinds: `mention`, `comment_reply`, `task_assigned`, `member_added`, `document_restored`.
`SearchHit = { type, id, workspaceId, documentId, title, snippet, highlights: [start, end][], score, updatedAt }`.
Results only include workspaces the caller currently belongs to.

## WebSocket protocol (`/ws`)

Connect to `ws(s)://<host>/ws`. Browsers must connect from the server's own origin or from an origin listed in
`CORS_ORIGINS`. Frames are JSON text, 256 KiB at most. The **first frame must be** `{"type":"auth","token":"<accessToken>"}`
and must arrive within `authTimeoutMs` (5 s by default).

### Client → server

| type | fields | notes |
| --- | --- | --- |
| `auth` | `token` | first frame only |
| `ping` | `t` | answered with `pong`; also refreshes presence |
| `doc.join` | `docId` | viewer+. Answered with `doc.joined`. Re-sending forces a fresh snapshot (resync) |
| `doc.leave` | `docId` | |
| `doc.op` | `docId`, `op` | editor+. `op` is an RGA insert/delete (see below) using the site from `doc.joined` |
| `doc.ack` | `docId`, `seq` | highest server sequence integrated (enables tombstone GC) |
| `presence.update` | `docId`, `cursor: { anchor, head } \| null` | anchors are element keys or `null` (document start) |
| `workspace.subscribe` / `workspace.unsubscribe` | `workspaceId` | viewer+. Receive workspace events and online users |

RGA operations:

```jsonc
{ "kind": "insert", "site": "c3k…", "seq": 7, "clock": 42, "after": "17@init" /* or null */, "text": "hello" }
{ "kind": "delete", "site": "c3k…", "seq": 8, "clock": 48, "spans": [{ "site": "init", "clock": 3, "length": 4 }] }
```

### Server → client

| type | fields |
| --- | --- |
| `ready` | `userId`, `connectionId`, `heartbeatMs` |
| `pong` | `t` |
| `error` | `code`, `message`, `docId?` (same codes as HTTP) |
| `doc.joined` | `docId`, `site`, `snapshot`, `seq`, `role`, `peers` |
| `doc.op` | `docId`, `op`, `seq`, `userId` (ops from other clients or server restores) |
| `doc.ack` | `docId`, `seq`, `opSeq` (your op `opSeq` was integrated as `seq`) |
| `doc.resync` | `docId`, `reason`: re-send `doc.join` and rebase unacknowledged ops |
| `doc.meta` | `docId`, `title` |
| `doc.closed` | `docId`, `reason` (deleted, access revoked, workspace deleted) |
| `presence.update` / `presence.leave` | `docId`, `peer` / `connectionId` |
| `workspace.event` | `workspaceId`, `event` with `kind` ∈ `task.upserted`, `task.deleted`, `comment.upserted`, `comment.deleted`, `document.upserted`, `document.deleted`, `activity`, `members.changed` |
| `workspace.online` | `workspaceId`, `userIds` |
| `notification` | `notification`, `unreadCount` |

### Close codes

| code | meaning |
| --- | --- |
| 4001 | no `auth` frame within the timeout |
| 4003 | authentication failed, or the first frame was not `auth` |
| 4008 | rate limited (too many messages or connections) |
| 4010 | session revoked (logout, refresh-token reuse, password change) |
| 1007 | too many invalid frames, or binary frames |
| 1001 | server shutting down |

Per-socket messages are rate limited (200 burst, 100/s by default). Sockets that do not answer pings within one
heartbeat interval are terminated, and peers silent for `presenceTimeoutMs` are removed from presence.
