# Architecture

## Overview

```
 Browser (React SPA)                                   Node process (apps/server)
 ┌──────────────────────────────┐   HTTPS /api   ┌──────────────────────────────────────────────┐
 │ ApiClient (fetch, refresh)   │──────────────▶│ http: Router → RequestContext → route modules │
 │ RealtimeClient (ws, backoff) │◀─────────────▶│ realtime: RealtimeGateway (/ws)              │
 │ DocumentSync (RGA replica)   │   WebSocket    │            PresenceTracker                   │
 │ Editor overlay, pages        │                │ services: Auth, Workspace, Document, Comment,│
 └──────────────┬───────────────┘                │   Task, Notification, Activity, Search,      │
                │                                │   DocSessionManager (server RGA replicas)    │
                │ @rcp/shared                    │ core: config, logger, metrics, EventBus,     │
                ▼                                │   rate limiter, errors                        │
 ┌──────────────────────────────┐                │ repositories ─▶ Database (node:sqlite, WAL)  │
 │ RGA CRDT · zod protocol ·    │◀───────────────│                                              │
 │ permissions · text diff      │                └──────────────────────────────────────────────┘
 └──────────────────────────────┘
```

The monorepo has three npm workspaces. `@rcp/shared` has no runtime dependencies besides zod, and it is the only code
the client and the server share: the CRDT, the wire protocol schemas and DTO types, and the permission table. Sharing
the permission table means the UI hides exactly the controls the server would reject.

## Server layers

| Layer | Responsibility | Key files |
| --- | --- | --- |
| `core/` | Config loading/validation, JSON logger, Prometheus metrics, typed `AppError`s, `EventBus`, token-bucket `RateLimiter`, ids/clock utilities | `config.ts`, `events.ts`, `metrics.ts` |
| `db/` | `Database` wrapper (statement cache, nested transactions via savepoints), ordered checksummed migrations | `database.ts`, `migrations.ts` |
| `repositories/` | SQL only: one class per aggregate, columns aliased to camelCase, explicit parameter objects | `documents.ts`, `tasks.ts`, … |
| `auth/` | scrypt hashing, HS256 JWT, `AuthService` (sessions, rotation, reuse detection) | `auth-service.ts` |
| `services/` | Business rules and authorization (`AccessControl`), activity recording, notifications, events | `*-service.ts`, `context.ts` |
| `services/doc-sessions.ts` | Authoritative in-memory replica per open document: sequencing, op log, snapshots, GC, eviction | |
| `search/` | Analyzer, inverted index with BM25F ranking and snippets, permission-aware `SearchService` | |
| `realtime/` | `RealtimeGateway` (auth handshake, message validation, rooms, broadcasts, heartbeats) and `PresenceTracker` | |
| `http/` | Router (405 detection), `RequestContext` (body limits, schema parsing), security headers/CORS, static SPA serving, route modules | |
| `app.ts` | Composition root: `createCore` (DB + services) and `createApp` (adds HTTP server, gateway, maintenance timers) | |

Services never touch transport. After a write commits they emit **domain events** (`task.upserted`,
`comment.upserted`, `notification.created`, `membership.changed`, `session.revoked`, …) on the synchronous `EventBus`:

- the **gateway** turns them into WebSocket messages for workspace rooms, document rooms or user connections, and
  re-authorizes or evicts connections when memberships change or sessions are revoked;
- the **search service** updates its index.

This keeps every service unit-testable without sockets, and lets the HTTP API and the realtime API share all
business logic.

## Request lifecycle (HTTP)

1. Assign or propagate the request id, apply security headers, answer CORS preflights.
2. Global per-IP token bucket. Auth routes also use a stricter bucket.
3. Route match (`404` / `405` with `Allow`), then bearer-token authentication. `AuthService.authenticate` verifies
   the JWT *and* that its session has not been revoked.
4. The handler parses the body or query with the shared zod schemas (`422` with field issues on failure) and calls a
   service. The service checks the role through `AccessControl`. Non-members get `404`, insufficient roles get `403`.
5. The result is wrapped as `{ data }`, or `204` for `undefined`. Any thrown `AppError` becomes `{ error }` with its
   status. Unknown errors are logged and returned as `500` without internals.

## Realtime document flow

```
client A                         server (DocSession)                        client B
  │ doc.join ───────────────────▶ load snapshot + replay op log
  │◀──────────── doc.joined {snapshot, seq, site=cA, role, peers}
  │ local edit → RGA op (site cA)
  │ doc.op ─────────────────────▶ checks: joined? role≥editor? op.site==cA?
  │                               dup? clock ≤ lamport+1? canApply? size?
  │                               apply → seq=n → append op log
  │◀─────────────── doc.ack {seq:n, opSeq}        doc.op {op, seq:n} ─────▶ apply → text changes
  │ doc.ack {seq} (debounced) ──▶ participant.ackSeq = n          ◀────── doc.ack {seq}
```

- The **server is the sequencer**. Ops are integrated in arrival order and receive a monotonically increasing `seq`.
  Each connection gets a fresh site id at join time, so clients cannot forge ops for another replica.
- **Invalid ops** (wrong site, missing dependencies, clock jumps, document too large) are not applied; the client
  gets `doc.resync`. `DocumentSync` then re-joins, loads the fresh snapshot and **rebases** its unacknowledged ops:
  ops the server already integrated (according to the version vector) are skipped, the rest are re-issued against
  the new replica with old element ids mapped to new ones. The same path handles reconnects after a network drop.
- **Persistence**: every integrated op is appended to `document_ops`. Every `snapshotEveryOps` ops (and on eviction
  or shutdown) the replica is serialized into `documents.snapshot`, and the covered log rows are deleted. Loading a
  document means snapshot plus replay of the remaining log, so a crash loses nothing that was acknowledged.
- **Garbage collection** runs at compaction time only when every connected participant has acknowledged the head
  (`DocSession.isQuiescent`). Element keys referenced by comment anchors are retained. Clients are not told about
  GC; they keep their tombstones, which is safe (see [docs/crdt.md](docs/crdt.md)).
- **Version restore** diffs the current text against the version line by line (LCS), then character by character
  inside changed blocks. It applies the result as server-generated ops through the same broadcast path, so untouched
  text keeps its identity (comment anchors and cursors stay put).

## Presence and heartbeats

The gateway pings every socket each `heartbeatIntervalMs` and terminates sockets that did not answer the previous
ping. Separately, `PresenceTracker` records `lastSeen` for every (document, connection) pair, refreshed by any
message from the connection. Clients send app-level pings at the server-advertised interval. Peers that stay silent
for longer than `presenceTimeoutMs` are removed, and `presence.leave` is broadcast. Cursors are sent as CRDT anchors
(the key of the character before the caret), so remote carets move correctly with concurrent edits.

## Client architecture

- `ApiClient`: typed endpoints, envelope unwrapping, single-flight token refresh, session persistence.
- `RealtimeClient`: authenticates with the first frame, reconnects with exponential backoff and jitter, keeps
  ref-counted document and workspace subscriptions and replays them after reconnecting, and stops on
  `sessionRevoked`.
- `DocumentSync`: framework-free sync engine (unit-tested in Node). It owns the RGA replica, turns textarea values
  into ops (caret-aware diff), applies remote ops, transforms the local selection, tracks peers and runs the rebase
  logic.
- `CollaborativeEditor`: a transparent `<textarea>` over a mirror `<div>` with identical typography. `buildOverlay`
  splits the text into runs carrying remote selection and comment highlights, plus zero-width carets with name
  labels. This lines up without measuring glyphs and keeps native editing (IME, spellcheck, undo within the field).
- Pages subscribe to workspace events (`useRealtimeMessages`) and patch their local state, so boards, comment lists,
  document lists and activity feeds update live.

## Security model (summary)

See [SECURITY.md](SECURITY.md). In short: scrypt password hashes, short-lived HS256 tokens tied to revocable
sessions, rotating hashed refresh tokens with reuse detection, server-side role checks on every HTTP route and WS
message, existence hiding for non-members, zod validation everywhere, size limits on bodies and frames, rate
limiting, CSP and related headers, a CORS allow-list and Origin checks on WebSocket upgrades.

## Key decisions and trade-offs

| Decision | Why | Cost |
| --- | --- | --- |
| Own RGA instead of Yjs/Automerge | Required by the brief, and it keeps the algorithm inspectable | Fewer optimizations (O(n) index lookups) |
| Central sequencer plus CRDT | Simple authorization and ordering, a cheap op log, easy resync | One process per document (no P2P) |
| `node:sqlite` | Ships with Node, no native build step | Synchronous API (fine for this workload) |
| Hand-written HTTP layer | Small surface, explicit limits and envelopes, fewer dependencies | More code to maintain than adopting Fastify |
| In-memory search index | Fast, permission filtering at query time | Rebuilt at startup, memory proportional to content |
