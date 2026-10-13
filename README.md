# Realtime Collaboration Platform

A full-stack TypeScript workspace for teams: documents edited together in realtime with live cursors, threaded
comments anchored to text, a kanban task board, in-app notifications, version history, activity feeds and full-text
search, all under workspace roles that are enforced on every HTTP request and WebSocket message.

The collaborative editor runs on a **sequence CRDT written for this project** (RGA with Lamport clocks, tombstones and
garbage collection). The same CRDT code runs in the browser and on the server, and randomized property tests check
that replicas converge.

```
packages/shared   @rcp/shared  RGA CRDT, wire protocol (zod), role/permission model   (used by both sides)
apps/server       @rcp/server  Node HTTP + WebSocket server, SQLite (node:sqlite), search, CLI
apps/web          @rcp/web     React + Vite single-page client
tests/            integration tests (in-process server, real WebSocket clients)
```

## Implemented functionality

| Area | What exists |
| --- | --- |
| Authentication | Registration and login with scrypt hashes (`node:crypto`; hashes are upgraded on login when the cost changes). HS256 JWT access tokens bound to a server-side session. Opaque refresh tokens are stored hashed and rotated on every use, and reusing an old one revokes the session. Logout, logout-all and password change (which revokes other sessions). |
| Workspaces & roles | `owner > admin > editor > commenter > viewer`. One shared permission table drives server checks and UI affordances. Member management follows role-assignment rules, ownership can be transferred, and non-members get `404` rather than `403`. |
| Realtime documents | RGA CRDT ops over `ws`. The server assigns each connection its own CRDT site and orders ops with sequence numbers. It acks the sender, relays to everyone else, and asks a client to resync when an op is invalid. Clients rebase unacknowledged edits after a reconnect. |
| Persistence | SQLite with versioned, checksummed migrations. Ops go to an op log that is compacted into snapshots every N ops, and the tombstone GC runs when every connected replica has acknowledged the head. Idle documents are flushed and evicted from memory. |
| Presence | Cursors and selections stored as CRDT anchors, so they stay put when others type. Shows who is online per document and workspace, with app-level heartbeats, WebSocket ping/pong and presence timeouts. |
| Comments | Threads (root plus replies) anchored to character ids. Resolve and reopen, edit (author only), delete (author or admin). `@mentions` notify workspace members. Replies notify thread participants. Anchored characters survive GC. |
| Notifications | Persisted, read/unread, paginated with keyset cursors, and pushed over WebSocket to every open tab with the live unread count. |
| Activity & versions | Workspace and document activity feeds with keyset paging. Edits are recorded at most once per user and time window. Named version snapshots can be previewed and restored. A restore is applied as CRDT ops (line diff), so connected editors converge without reloading, and the pre-restore text is saved first. |
| Tasks | Kanban columns (todo / in progress / review / done) ordered by fractional positions, renumbered when gaps run out. Each task has an assignee, due date, priority, labels and an optional linked document. Drag and drop, filters, realtime updates, and a notification when a task is assigned. |
| Search | In-memory inverted index over documents, comments and tasks. Uses BM25F-style ranking (title weighted above body), diacritic folding, stop words, a light stemmer, prefix matching on the last word and highlighted snippets. Results are filtered by the caller's current memberships. |
| Hardening | zod validation at every boundary (HTTP bodies, queries, path ids, WS frames). Typed error envelopes and token-bucket rate limits (global, auth, per-socket). CORS allow-list plus an Origin check on WebSocket upgrades, CSP and other security headers, body and frame size limits, and backpressure on slow WebSocket consumers. |
| Observability | Structured JSON logs (secrets redacted), request ids, Prometheus `/metrics` (optionally token-protected), `/healthz` and `/readyz`. |
| UI | Responsive React SPA with these screens: login/register, workspace list, documents, collaborative editor with remote cursors and name labels, comments sidebar, version history, task board, activity feed, members, notifications menu, search, connection indicator and toasts. |
| Tooling | CLI (`migrate`, `seed`, `create-user`, `compact`, `prune-sessions`, `stats`), example scripts, Dockerfile, compose file and CI workflow. |

## Technology stack

TypeScript 5.9 (`strict`, `noUncheckedIndexedAccess`) · Node.js ≥ 22.13 (developed on 25.9) · `node:sqlite` ·
`ws` 8 · zod 4 · React 19 · Vite 7 · Vitest 4 · ESLint 9 + typescript-eslint. The HTTP layer (router, body parsing,
CORS, rate limiting, static serving), JWT handling, metrics and the search engine are implemented in the repository
rather than pulled in as frameworks; there are no native modules to compile.

## Quick start

```bash
npm ci
npm run build                     # shared + server (tsc) and web (vite build)
npm run cli -- seed --password demo-password-123   # demo users alice/bob/carol/dave
npm start                         # http://127.0.0.1:4000 serves the API, /ws and the web UI
```

Log in as `alice` / `demo-password-123`, open **Acme Launch → Product brief**, then log in as `bob` in a second
browser profile to see live cursors. See [GETTING_STARTED.md](GETTING_STARTED.md) for the development workflow
(Vite dev server with proxy), configuration and troubleshooting.

## Configuration

Defaults are layered: built-ins, then an optional JSON file (`CONFIG_FILE`), then environment variables. The merged
result is validated at startup. Production refuses to start without a real `JWT_SECRET` (at least 32 characters).
All variables are listed in [.env.example](.env.example); `examples/config.example.json` shows the file format.

## API

REST under `/api` with `{ "data": ... }` / `{ "error": { code, message, details?, requestId } }` envelopes, plus a
WebSocket protocol at `/ws`. Every endpoint, message type and error code is documented in [API.md](API.md). Runnable
examples:

- `examples/api-walkthrough.sh` (curl, from register through logout)
- `examples/two-clients.mjs` (two WebSocket clients edit concurrently and converge)
- `examples/requests.http` (sample requests for REST-client editors)

## Testing

```bash
npm test            # vitest: shared, server, web and integration projects
npm run typecheck   # tsc across all packages, including test files
npm run lint        # eslint
```

At the time of writing: **279 tests** (shared 114, server 101, web 33, integration 31), all passing. Integration tests
start the real HTTP and WebSocket server in-process with real `ws` clients. They cover multi-client convergence,
reconnect rebasing, presence timeouts, permission revocation and persistence across restarts. See
[docs/testing.md](docs/testing.md).

## Deployment

The server is a single Node process. It serves the API, the WebSocket endpoint and the built SPA, and keeps its state
in one SQLite file. A multi-stage `Dockerfile` and `compose.yaml` are provided; **they were written carefully but not
built or run locally, because Docker is not installed on the development machine.** Operational guidance (backups,
metrics, CLI maintenance) is in [docs/operations.md](docs/operations.md).

## Limitations

- **Plain-text editor.** It is a textarea with an overlay. There is no rich text, Markdown rendering or embeds.
- **Single process only.** Document sessions, presence, the search index and rate limiters live in memory. There is
  no cross-node pub/sub, so running several replicas behind a load balancer would split rooms.
- **CRDT performance.** The CRDT is a linked list with O(n) index lookups. That is fine up to the 500 000-character
  document cap, but there is no balanced-tree index.
- **Text indexing.** The CRDT indexes UTF-16 code units. Concurrent inserts can in theory land between the two halves
  of a surrogate pair (for example an emoji).
- **Tombstone collection timing.** Tombstones are collected only at quiescent points (every connected replica has
  acked the head) or when an idle document is unloaded. Browser replicas keep their tombstones until they reload.
- **Offline-rebase fallback.** If a client was offline long enough for the server to collect a tombstone its pending
  insert referenced, the rebased text is appended at the end of the document instead of its original position.
- **WebSocket token lifetime.** A socket is authenticated once, at connect. After that it is closed on logout,
  session revocation or loss of membership, but not when the access token merely expires.
- **Refresh token storage.** The refresh token lives in `localStorage`, which exposes it to XSS. An httpOnly-cookie
  flow is not implemented.
- **Missing account features.** There is no e-mail verification, password reset, e-mail invitations or SSO.
- **Search.** The index is in memory and rebuilt at startup. It has an English-only stemmer and no fuzzy matching,
  and document text reaches the index after a short flush delay (1 s by default).
- **Version history.** Every version is a full text copy, with no retention policy and no diff view.
- **Verification gaps.** The Docker image and compose file were not built. The CI workflow has never run (no
  GitHub). The UI was verified with a scripted headless-Chrome session and screenshots (login, live remote edits and
  carets, typing, board, search, mobile width) but not across browsers. Kanban drag and drop needs a pointer; keyboard
  users change status in the task dialog.

## Roadmap

1. Redis (or similar) pub/sub plus sticky sessions so the server can scale horizontally.
2. Rich-text model (marks and blocks) on top of the sequence CRDT, and a proper editor surface.
3. httpOnly refresh cookie with CSRF protection, plus e-mail verification and invites.
4. An order-statistics tree for O(log n) CRDT position lookups, and binary snapshot encoding.
5. Version diff view, retention policies and per-document permissions.
6. A persistent search index (SQLite FTS5 adapter) and multilingual analyzers.

## AI-assisted development

This project was developed with AI assistance (Claude by Anthropic). The design, code, tests and documentation were
produced in an AI-assisted workflow and checked by running the full test suite (279 tests), the TypeScript compiler
and ESLint, a production build, a live smoke test (curl walkthrough plus the two-client WebSocket example) and a
scripted headless-browser check of the UI. Items that could not be verified locally are listed under Limitations.

## License

MIT © Robert Ramos. See [LICENSE](LICENSE).
