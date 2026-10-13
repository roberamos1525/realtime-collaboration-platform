# Testing

```bash
npm test                                  # all projects
npx vitest run --project shared           # CRDT, diff, mentions, permissions, schemas
npx vitest run --project server           # services, auth, DB, search, HTTP primitives, CLI
npx vitest run --project web              # sync engine, API/socket clients, overlay, router, UI helpers
npx vitest run --project integration      # real HTTP + WebSocket server in-process
```

Vitest projects are defined in `vitest.config.ts`. `@rcp/shared` is aliased to its TypeScript source, so tests never
depend on build output. Test files are also type-checked (`tests/tsconfig.json` includes every `*.test.ts`).

## Current results

`npm test` → **279 passed** (shared 114, server 101, web 33, integration 31), run time about 6 s on the development
machine. The suite was run repeatedly to check for flakiness. Notifications created within the same millisecond
are ordered by random id, so tests that read "the latest notification" first clear the inbox.

## What is covered

### Shared (`packages/shared`)
- **Convergence properties**: 40 seeds × 2–5 replicas with random inserts and deletes, shuffled and partial
  delivery, 5 % duplicate delivery. Checks identical text, no pending ops, and a change-event stream that rebuilds
  the same text. Also covered: GC at quiescent points (random subsets of replicas collect, editing continues), late
  joiners from snapshots, and all permutations of 3 concurrent ops.
- RGA unit tests: tie-breaking, non-interleaving runs, change events for split deletes, buffering, duplicates after
  GC, Lamport advancement, pending limits, anchors, snapshot round-trips and corruption checks, and a 500-step
  single-replica comparison against a plain string model.
- Diff (caret disambiguation, random round-trips, line diff keeping CRDT identity), mentions, permissions matrix
  monotonicity, schema normalisation.

### Server (`apps/server/src/**`)
- Config layering, validation and production secret enforcement; error envelopes; rate limiter refill and memory
  bounds; metrics exposition; log redaction; event bus isolation.
- Database savepoints, migration checksums and downgrade protection, atomic rollback of failed migrations, FK and
  CHECK constraints.
- Auth: scrypt, Unicode normalisation, rehash on cost change, JWT tampering, expiry, issuer and `alg=none`, refresh
  rotation and reuse detection, logout and logout-all, password change, session pruning.
- Role matrix across documents, comments, tasks, members and ownership transfer; existence hiding.
- Document sessions: sequencing, duplicate and invalid op rejection (site, clock, dependencies, size), crash
  recovery from the op log, compaction cadence, quiescence-gated GC, anchor retention, server-side text
  replacement, debounced content flush, eviction, edit-activity windows; version restore through CRDT ops.
- Comments (anchors, mentions limited to members, reply notifications, edit-only-new-mentions, resolve permissions,
  cascade delete), notifications (keyset paging, read/unread, push counts), tasks (ordering, renumbering,
  validation, filters, delete rights, events), activity paging.
- Search analyzer (folding, stemming, offsets), ranking, prefix expansion, snippets, permission filtering, index
  maintenance on rename, delete and workspace deletion.
- Router, body reader limits and media types, CORS and security headers, trusted proxy IPs, static file serving
  and traversal protection, CLI commands.

### Web (`apps/web/src/**`)
- `DocumentSync` against a deterministic fake server: concurrent convergence, selection transform, ack debounce,
  read-only refusal, offline rebase with id mapping, resync replay, give-up after repeated failures, presence anchor
  resolution, comment anchor ranges.
- `ApiClient` envelope handling, single-flight refresh on 401, session clearing, proactive refresh, network errors.
- `RealtimeClient` auth-first handshake, subscription replay, ref-counting, exponential backoff, revocation stop.
- Overlay segmentation, router matching, store, formatting, board ordering helpers, comment threading, search
  highlighting.

### Integration (`tests/integration`)
- HTTP: health, readiness and metrics auth; security headers and request ids; CORS; SPA fallback; 401, 405, 413,
  415 and 422 envelopes; full auth lifecycle (rotation, reuse, logout); a full workspace → document → comment → task
  → version → search → activity → delete workflow with role checks; auth rate limiting with `Retry-After`.
- WebSocket: auth timeout and failure close codes, Origin rejection, message validation, session revocation closing
  sockets, raw op relay and acks, site spoofing → resync, **three clients typing concurrently with the web
  `DocumentSync` engine converging to the server text**, viewer refusal, offline edits rebased after reconnect,
  version restore broadcast, presence anchors moving with edits, presence timeout, workspace events, multi-tab
  notifications, eviction on membership removal, live role downgrade, persistence across a server restart.

## Manual and scripted verification

- `examples/two-clients.mjs` against a running server prints `CONVERGED ✔`.
- `examples/api-walkthrough.sh` exercises the REST API with curl.
- During development the production build was also driven in headless Chrome through the DevTools protocol: log in
  through the form, open a seeded document, receive a remote user's edit and labelled cursor, type in the textarea
  and confirm the server and remote replica match, load the board and search pages, and render at 390 px width with
  no horizontal overflow and no console errors. That script lived outside the repository and is not part of the
  test suite. There are no automated browser tests (see Limitations in the README).
