# Operations runbook

## Process model

One Node process serves HTTP, WebSocket and static assets and owns one SQLite file. Do not run two processes
against the same database file and expect realtime to work across them. Rooms, presence, rate limits and the search
index are per process.

Recommended production setup:

```
client ──TLS──▶ reverse proxy (nginx/Caddy; WebSocket upgrade enabled, HSTS) ──▶ node apps/server/dist/index.js
```

Environment: `NODE_ENV=production`, `JWT_SECRET` (32+ random chars), `HOST=0.0.0.0` in containers, `CORS_ORIGINS`
set to the public origin if the UI is served from elsewhere, `TRUST_PROXY=true` only behind a proxy that overwrites
`X-Forwarded-For`, `HSTS=true` when served over HTTPS, `METRICS_TOKEN` when `/metrics` is reachable.

## Start, stop, health

- Start: `npm start` (or `node apps/server/dist/index.js`), or use the provided Docker image (not built locally).
- Stop: `SIGTERM`/`SIGINT` triggers graceful shutdown. Sockets are closed with code 1001, open documents are flushed
  and compacted, then the database is closed. A 10 s watchdog forces exit.
- Liveness: `GET /healthz`. Readiness: `GET /readyz` (runs a DB query and reports open sessions, connections and
  index size).

## CLI maintenance

```bash
npm run cli -- migrate                       # report or apply schema migrations (also automatic at startup)
npm run cli -- seed --password <pw>          # demo data (idempotent)
npm run cli -- create-user --email e --username u --name "Name" --password <pw>
npm run cli -- compact                       # snapshot every document, collect tombstones, trim op logs
npm run cli -- prune-sessions --days 7       # delete sessions expired/revoked more than 7 days ago
npm run cli -- stats                         # row counts per table
```

The CLI uses the same configuration (`DATABASE_PATH`, `CONFIG_FILE`, …) as the server. Run `compact` while the
server is stopped: the server's in-memory sessions would not see CLI changes.

## Backups

SQLite in WAL mode can be copied consistently with the online backup command:

```bash
sqlite3 var/rcp.sqlite ".backup 'backup-$(date +%F).sqlite'"
```

Without the `sqlite3` CLI, stop the server and copy `rcp.sqlite` together with any `-wal`/`-shm` files. To restore,
stop the server, replace the files and start again. Migrations run automatically.

## Metrics (`/metrics`)

| Metric | Use |
| --- | --- |
| `rcp_http_requests_total{method,route,status}` / `rcp_http_request_duration_seconds` | traffic, error rate, latency per route pattern |
| `rcp_rate_limited_total{scope}` | `global`, `auth`, `ws` throttling |
| `rcp_ws_connections`, `rcp_ws_messages_in_total{type}`, `rcp_ws_messages_out_total` | realtime load |
| `rcp_doc_ops_total{kind}`, `rcp_doc_ops_rejected_total{reason}` | editing activity; rising rejections point to client bugs or abuse |
| `rcp_doc_sessions`, `rcp_doc_snapshots_total`, `rcp_crdt_tombstones_collected_total` | memory and compaction health |
| `rcp_search_queries_total`, `rcp_search_index_entries` | search usage and index size |
| `rcp_notifications_total{kind}`, `rcp_auth_events_total{event}` | product and security signals (for example `refresh_reuse_detected`) |

## Logs

JSON lines on stdout: `time`, `level`, `msg` plus context (`requestId`, `documentId`, `connectionId`, …). Secrets
are redacted. Useful messages:

- `refresh token reuse detected; session revoked` (warn): possible token theft.
- `op rejected; asking client to resync` (info): includes `reason` (`missing_dependencies`, `clock_ahead`,
  `site_mismatch`, `document_too_large`).
- `terminating slow websocket consumer` (warn): a client could not keep up (`maxBufferedBytes`).
- `request failed` (error): unexpected 500 with stack.

## Capacity notes

- Each open document keeps its CRDT (characters plus tombstones) in memory. Idle documents (no participants for
  `idleEvictMs`, 5 min by default) are flushed and unloaded by a 30 s maintenance timer.
- The search index holds the text of every live document, comment and task.
- Rough guidance from the design (not benchmarked): suitable for small teams with documents up to a few hundred KB
  and tens of concurrent editors per document.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Users logged out after every restart | `JWT_SECRET` not set (an ephemeral dev secret is used) |
| WebSocket 403 on upgrade | Browser origin is not the server host and not in `CORS_ORIGINS` |
| Clients stuck on "Resynchronising…" | `rcp_doc_ops_rejected_total` reasons; client clock or site bugs |
| Database grows | Run `compact`, then `prune-sessions`; versions are full copies |
| `SQLITE_BUSY` | Another process holds the file; only one server per database |
