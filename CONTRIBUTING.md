# Contributing

## Setup

```bash
npm ci
npm run build      # needed once so packages/shared/dist exists for the server
```

## Workflow

1. Keep changes inside the right package boundary:
   - CRDT, protocol schemas, DTO types and permission rules belong in `packages/shared` (no Node or DOM APIs).
   - Business rules belong in `apps/server/src/services`; SQL only in `repositories`; transport concerns in `http/`
     and `realtime/`.
   - UI logic that can be tested without a DOM (sync, overlay, routing, API client) goes in `apps/web/src/lib`.
2. Validate external input with zod schemas from `@rcp/shared` and throw `AppError` subclasses for client errors.
3. Services emit domain events after their writes; do not call the gateway or search index directly.
4. Add tests next to the code (`*.test.ts`) and, for cross-cutting behaviour, an integration test in
   `tests/integration`.

## Checks (all must pass before merging)

```bash
npm run typecheck   # strict tsc for every package and all test files
npm run lint        # eslint (typescript-eslint, react-hooks)
npm test            # vitest: shared, server, web, integration
npm run build       # tsc + vite build
```

CI runs the same commands (`.github/workflows/ci.yml`).

## Conventions

- TypeScript `strict` with `noUncheckedIndexedAccess`. Avoid `any` outside tests.
- ES modules everywhere. Server imports use `.js` extensions (NodeNext resolution).
- Type-only imports use `import type` (enforced by lint).
- Database changes go in a **new** migration in `apps/server/src/db/migrations.ts`. Applied migrations are
  checksummed and must never be edited.
- CRDT changes need property tests (`packages/shared/src/crdt/convergence.test.ts`) covering reordering,
  duplication and garbage collection.
- Commit messages: short imperative subject, with a body explaining *why* when it is not obvious.
