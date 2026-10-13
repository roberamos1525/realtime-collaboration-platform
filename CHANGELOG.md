# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

## [0.1.0] - 2026-10-12

### Added

- `@rcp/shared`:
  - RGA sequence CRDT with Lamport clocks, per-site sequence numbers, a pending buffer for out-of-order delivery,
    tombstones, quiescent garbage collection with retained keys, run-length snapshots, and caret and range anchors.
  - Caret-aware text diff and line-level diff (LCS) used for version restore.
  - zod schemas for every HTTP body and WebSocket frame, and DTO types.
  - Role and permission table with role-assignment rules.
- Server:
  - Hand-written HTTP layer: router with 405 detection, JSON body limits, error envelopes, CORS, security headers,
    static SPA serving.
  - Authentication: scrypt passwords, HS256 JWT access tokens bound to sessions, rotating refresh tokens with reuse
    detection, logout and logout-all, password change.
  - Workspaces with owner/admin/editor/commenter/viewer roles, member management and ownership transfer.
  - Realtime document sessions: sequencing, op log plus snapshot compaction, GC at quiescence, idle eviction,
    restart recovery.
  - WebSocket gateway: auth handshake, Origin check, message validation, rate limits, presence with heartbeats and
    timeouts, live re-authorization on membership changes, session-revocation closes.
  - Threaded, anchored comments with mentions, resolve and reopen.
  - Notifications (persisted, paginated, pushed).
  - Activity feeds and document versions with live restore.
  - Kanban tasks with fractional ordering, filters, assignment notifications.
  - Search: inverted index with BM25F ranking, prefix matching, snippets and highlights, permission filtering.
  - SQLite persistence through `node:sqlite` with checksummed migrations.
  - Structured logging, Prometheus metrics, health and readiness endpoints.
  - CLI: migrate, seed, create-user, compact, prune-sessions, stats.
- Web client:
  - React SPA with login/registration, workspace list, document list.
  - Collaborative editor with remote cursors, selections and comment highlights.
  - Comments sidebar, version history, kanban board with drag and drop, activity feed, members management,
    notifications menu, search page, connection status, responsive layout.
- 279 automated tests, including CRDT convergence property tests and integration tests with real WebSocket clients.
- Examples (curl walkthrough, two-client convergence script, REST samples, config file), Dockerfile, compose file
  and CI workflow. The Docker files were not built locally.
