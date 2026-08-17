# Development

## What's actually implemented (Phases 1–3)

- `apps/web` — Next.js: `/login` (GitHub sign-in), an authenticated dashboard (`/`), a
  repository workspace (`/repositories` — sync from GitHub, search, remove, real ingestion
  status), a repository detail page (`/repositories/[id]` — "Analyze Repository", live progress,
  file counts on completion), and a `/status` page showing live
  API/Postgres/Redis/worker/GitHub-OAuth health.
- `apps/api` — Fastify: `GET /health`; GitHub OAuth (`/auth/github`, `/auth/github/callback`,
  `/auth/logout`, `/auth/me`, `/auth/status`); authenticated repository endpoints
  (`GET /repositories`, `GET/DELETE /repositories/:id`, `POST /repositories/connect`);
  authenticated ingestion endpoints (`POST /repositories/:id/ingestions`,
  `GET /repositories/:id/ingestions`, `GET /ingestions/:id`); session middleware, rate limiting,
  structured logging, centralized error handling.
- `apps/worker` — BullMQ workers for `test` (proves the queue round trip) and
  `repository-ingestion` (Phase 3's real pipeline — see
  [repository-ingestion.md](./repository-ingestion.md)); a Redis heartbeat the API's `/health`
  reads to report real (not hardcoded) worker liveness.
- `packages/database` — Prisma + pgvector. Models: `HealthCheck` (Phase 1); `User`,
  `GitHubAccount`, `Session`, `Repository` (Phase 2); `Ingestion`, `RepositoryFile` (Phase 3) —
  see [database.md](./database.md).
- `packages/shared` — the environment schema (Zod), `HealthStatus`, auth DTOs
  (`AuthenticatedUser`, `AuthStatus`, cookie name constants), `RepositoryDto`, ingestion DTOs
  (`IngestionDto`, `IngestionStatus`, the ingestion queue name/payload type), and the AES-256-GCM
  crypto implementation shared between `apps/api` and `apps/worker`.
- `packages/code-analysis` — file classification, ignore rules, and the extension→language map
  (Phase 3).
- `packages/ai` — still an empty placeholder; populated starting Phase 5.

No embeddings, AI agents, findings, or chat exist yet — see
[architecture.md](./architecture.md)'s phased roadmap.

## Prerequisites

- Node.js >= 20
- pnpm (`npm install -g pnpm`, or `corepack enable` if your Node build includes Corepack)
- Docker + Docker Compose
- A GitHub OAuth App if you want to actually sign in and ingest a repository — see
  [github-integration.md](./github-integration.md); the stack boots and runs fully without one,
  `/auth/github` just responds `503` until configured.

## Setup

```bash
cp .env.example .env       # ships working local-dev defaults, including a GitHub OAuth
                            # placeholder — see docs/github-integration.md to use real sign-in
pnpm install
```

`pnpm install` also generates the Prisma client (via each package's own `build`/`typecheck`
scripts calling `prisma generate`) — run `pnpm db:generate` directly if you ever need to force it.

## Running everything

The whole stack, containerized:

```bash
docker compose up --build
```

- Web: http://localhost:3000
- API: http://localhost:4000/health
- Postgres: localhost:5432 (`developer_platform` / `developer_platform`)
- Redis: localhost:6379

```bash
docker compose ps        # see what's running and healthy
docker compose logs -f   # tail logs across services (add a service name to scope it)
docker compose down      # stop and remove containers (add -v to also drop volumes)
```

## Running services individually (outside Docker)

Useful for fast iteration on one service at a time. Start Postgres/Redis via Docker either way:

```bash
docker compose up -d postgres redis
pnpm --filter @developer-platform/database prisma:migrate   # first time / after schema changes
pnpm dev                                                     # runs web + api + worker via turbo
```

Or scope to one app: `pnpm --filter @developer-platform/api dev`.

## How the services talk to each other

- `apps/web` calls `apps/api` over plain HTTP. Server Components use the server-side `API_URL` env
  var (the Docker service name, e.g. `http://api:4000`, inside Compose) and forward the browser's
  session cookie by hand (`apps/web/src/lib/api.ts` — a Server Component doesn't share the
  browser's cookie jar automatically). The "Continue with GitHub" link and any client-side calls
  (including the repositories/ingestion pages' polling and actions) use `NEXT_PUBLIC_API_URL`
  (the host-exposed port, e.g. `http://localhost:4000`), since those are real browser requests,
  not server-to-server ones.
- `apps/api` and `apps/worker` both connect directly to Postgres (via `@developer-platform/database`'s
  Prisma client) and Redis. `apps/worker` writes a liveness heartbeat to Redis that `apps/api`
  reads for `/health`. As of Phase 3, `apps/api` also **enqueues** BullMQ jobs onto the
  `repository-ingestion` queue (`apps/api/src/queue.ts`) that `apps/worker` consumes
  (`apps/worker/src/jobs/ingestion-job.ts`) — the first real producer/consumer pairing between the
  two processes.

## Environment variables

See [.env.example](../.env.example) for the full, commented list. Required-to-boot vars
(`DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`GITHUB_TOKEN_ENCRYPTION_KEY`, `WEB_URL`, `API_PUBLIC_URL`) are validated at process start in both
`apps/api` and `apps/worker` (`packages/shared/src/env.ts`) — a misconfigured deploy fails
immediately with a readable error instead of a runtime stack trace later. `.env.example` ships
working local-dev placeholders for all of them (the GitHub credentials are syntactically valid but
not real — see [github-integration.md](./github-integration.md) to use real sign-in).
Phase 3 adds `INGESTION_WORKSPACE_DIR`, `MAX_REPOSITORY_SIZE_MB`, `MAX_FILE_SIZE_MB`,
`MAX_FILES_PER_REPOSITORY` — all have sensible defaults (see
[repository-ingestion.md](./repository-ingestion.md)), so nothing needs to be set to boot.
`OPENAI_API_KEY` is reserved for a later phase and stays optional.

## Common commands

```bash
pnpm lint          # eslint across every package
pnpm typecheck     # tsc --noEmit across every package (next typegen first, for apps/web)
pnpm test          # vitest across every package
pnpm build         # turbo build (tsup for api/worker, next build for web, tsc for libs)
```

Each runs through Turborepo, so only what changed (and its dependents) actually re-runs on repeat
invocations. Several `apps/api` and `apps/worker` tests are integration tests that exercise a real
Postgres (and, for the BullMQ round trip, Redis) — they skip themselves (not fail) when the
dependency isn't reachable, and run for real against `docker compose up -d postgres redis` or a
local Postgres/Redis.

## Package structure

```
apps/{web,api,worker}        deployable applications
packages/database             Prisma schema + client (the only thing that talks to Postgres directly)
packages/shared                cross-cutting types/DTOs, env validation, crypto — safe to import anywhere
packages/code-analysis          file classification, ignore rules, language map (Phase 3+)
packages/ai                      empty — populated starting Phase 5
packages/config                 shared eslint/tsconfig/prettier, not runtime code
```

### A Turbopack quirk worth knowing about

`apps/web`'s production build (`next build`, Turbopack) fails to resolve *value* re-exports
(constants, functions — not types) routed through a workspace package's main barrel
(`packages/shared/src/index.ts`'s `export * from`). Type-only re-exports through the same barrel
are fine, and `apps/api`/`apps/worker` import the barrel's values without issue (they bundle with
tsup/esbuild, not Turbopack). The fix: value exports `apps/web` needs are also exposed as a direct
package subpath (see `packages/shared/package.json`'s `"exports"` map — `/auth`, `/ingestion`) and
imported from there instead of the barrel — see the comment in `apps/web/src/lib/api.ts`. This
came up again in Phase 3 (`isActiveIngestionStatus`) and was fixed the same way.
