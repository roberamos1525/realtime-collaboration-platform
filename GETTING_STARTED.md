# Getting started

## Prerequisites

- Node.js **22.13 or newer**, because `node:sqlite` is unflagged from 22.13. The project was developed and tested on
  Node 25.9 under Windows 11. On Node 22/23 `node:sqlite` may print an "experimental" warning, which is harmless.
- npm 10+ (npm 11 used during development).
- No C compiler, database server or Docker is needed.

## Install and build

```bash
npm ci                 # installs all workspaces from package-lock.json
npm run build          # tsc -b (shared, server) + vite build (web)
```

Build output goes to `packages/shared/dist`, `apps/server/dist` and `apps/web/dist`. All of these are git-ignored.

## Run (production-like, single process)

```bash
npm run cli -- seed --password demo-password-123   # optional demo data
npm start                                           # http://127.0.0.1:4000
```

The server serves the API (`/api`), the WebSocket endpoint (`/ws`) and the built web client. Without `JWT_SECRET` a
random development secret is generated at every start (a warning is logged), so sessions do not survive a restart.
Set `JWT_SECRET` to keep users logged in across restarts:

```bash
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm start
```

Demo users: `alice` (owner), `bob` (editor), `carol` (commenter), `dave` (viewer), all with the password you passed
to `seed`. Open the app in two browser profiles (for example a normal and a private window) as `alice` and `bob` to
see live cursors, comments and board updates.

## Development workflow

Run the API and the Vite dev server side by side:

```bash
npm run dev:server     # tsx watch on apps/server/src (port 4000)
npm run dev:web        # vite on http://localhost:5173, proxies /api and /ws to :4000
```

The dev server resolves `@rcp/shared` straight from source, so CRDT or protocol changes hot-reload in the client.
The server dev script also imports the shared package through its workspace link. Run `npm run build` once (or
`npx tsc -b packages/shared`) so `packages/shared/dist` exists.

## Configuration

Values come from built-in defaults, then the optional JSON file named by `CONFIG_FILE`, then environment variables.
The result is validated at startup, and invalid values stop the process with a readable message. Common settings:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT`, `HOST` | `4000`, `127.0.0.1` | Use `HOST=0.0.0.0` in containers |
| `DATABASE_PATH` | `./var/rcp.sqlite` | Parent directories are created automatically |
| `JWT_SECRET` | random (dev only) | **Required in production**, at least 32 characters |
| `CORS_ORIGINS` | Vite dev origins | Comma-separated; also used for WebSocket Origin checks |
| `STATIC_DIR` | `apps/web/dist` if built | Directory containing `index.html` |
| `METRICS_TOKEN` | unset | When set, `/metrics` needs `Authorization: Bearer <token>` |
| `SNAPSHOT_EVERY_OPS` | `200` | Op-log compaction interval |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |

See [.env.example](.env.example) for the full list. Rate limits, heartbeat and presence timings, and other nested
settings can be set in the JSON file (`examples/config.example.json`).

## Verifying an installation

```bash
curl http://127.0.0.1:4000/healthz                       # {"data":{"status":"ok"}}
bash examples/api-walkthrough.sh                         # register → workspace → doc → search → logout
node examples/two-clients.mjs                            # prints CONVERGED ✔ and exits 0
```

## Tests and quality checks

```bash
npm test               # all vitest projects (shared, server, web, integration)
npx vitest run --project integration   # only the end-to-end server tests
npm run typecheck
npm run lint
```

## Troubleshooting

- **`ERR_UNKNOWN_BUILTIN_MODULE node:sqlite`**: your Node is older than 22.13.
- **`configuration error: … JWT_SECRET must be set in production`**: set `JWT_SECRET` when `NODE_ENV=production`.
- **WebSocket closes with 4003**: the access token is invalid or expired. The web client refreshes automatically;
  custom clients must send a fresh token in the first `auth` frame.
- **WebSocket upgrade returns 403**: the page origin is neither the server's own host nor listed in `CORS_ORIGINS`.
- **UI shows "Page not found" or the API answers 404 for `/`**: the web client is not built (`npm run build`) or
  `STATIC_DIR` points to the wrong directory.
