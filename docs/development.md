# Development

## What's actually implemented (Phases 1–7)

- `apps/web` — Next.js: `/login` (GitHub sign-in), an authenticated dashboard (`/`), a
  repository workspace (`/repositories` — sync from GitHub, search, remove, real ingestion
  status), a repository detail page (`/repositories/[id]` — ingestion status/progress, a "Code
  Intelligence" panel to analyze the repository once ingested, a "Semantic Index" panel to index it
  for search once analyzed, an "AI Analysis" panel to run the seven agents once indexed), an
  analysis detail page (`/repositories/[id]/analyses/[analysisId]` — severity summary,
  filterable/paginated findings table, a file-level code explorer), a Code Search page
  (`/repositories/[id]/search` — semantic + lexical retrieval, expandable results with citations
  and score breakdowns), an AI Analysis detail page
  (`/repositories/[id]/ai-analysis/[analysisId]` — executive summary, per-agent cards, a
  filterable/paginated/expandable AI findings table with citations), and a `/status` page showing
  live API/Postgres/Redis/worker/GitHub-OAuth health.
- `apps/api` — Fastify: `GET /health`; GitHub OAuth (`/auth/github`, `/auth/github/callback`,
  `/auth/logout`, `/auth/me`, `/auth/status`); authenticated repository endpoints
  (`GET /repositories`, `GET/DELETE /repositories/:id`, `POST /repositories/connect`);
  authenticated ingestion endpoints (`POST /repositories/:id/ingestions`,
  `GET /repositories/:id/ingestions`, `GET /ingestions/:id`); authenticated analysis endpoints
  (`POST /repositories/:id/analyses`, `GET /repositories/:id/analyses`, `GET /analyses/:id`,
  `GET /analyses/:id/findings`, `GET /analyses/:id/files`, `GET /analyses/:id/files/:fileId`);
  authenticated embedding/search endpoints (`POST /repositories/:id/embeddings`,
  `GET /repositories/:id/embeddings`, `GET /embeddings/:id`, `POST /repositories/:id/search` — see
  [semantic-search.md](./semantic-search.md)); authenticated AI-analysis endpoints
  (`POST /repositories/:id/ai-analysis`, `GET /repositories/:id/ai-analysis`,
  `GET /ai-analysis/:id`, `GET /ai-analysis/:id/agents`, `GET /ai-analysis/:id/findings`,
  `GET /ai-analysis/:id/findings/:findingId` — see [ai-analysis.md](./ai-analysis.md)); session
  middleware, rate limiting, structured logging, centralized error handling.
- `apps/worker` — BullMQ workers for `test` (proves the queue round trip), `repository-ingestion`
  (Phase 3's pipeline — see [repository-ingestion.md](./repository-ingestion.md)),
  `code-analysis` (Phase 4's pipeline — see [code-intelligence.md](./code-intelligence.md)),
  `embeddings` (Phase 5's chunking/embedding pipeline — see
  [semantic-search.md](./semantic-search.md)), and `ai-analysis` (Phase 6's seven-agent
  orchestration pipeline — see [ai-analysis.md](./ai-analysis.md)); a Redis heartbeat the API's
  `/health` reads to report real (not hardcoded) worker liveness.
- `packages/database` — Prisma + pgvector. Models: `HealthCheck` (Phase 1); `User`,
  `GitHubAccount`, `Session`, `Repository` (Phase 2); `Ingestion`, `RepositoryFile` (Phase 3);
  `AnalysisRun`, `CodeSymbol`, `CodeImport`, `DependencyEdge`, `CodeMetric`, `Finding` (Phase 4);
  `EmbeddingRun`, `CodeChunk` (Phase 5 — the first real `vector` column, HNSW-indexed);
  `AIAnalysisRun`, `AgentRun`, `AIFinding` (Phase 6 — the first AI-generated data in this schema)
  — see [database.md](./database.md).
- `packages/shared` — the environment schema (Zod), `HealthStatus`, auth DTOs
  (`AuthenticatedUser`, `AuthStatus`, cookie name constants), `RepositoryDto`, ingestion DTOs
  (`IngestionDto`, `IngestionStatus`, the ingestion queue name/payload type), analysis DTOs
  (`AnalysisRunDto`, `FindingDto`, `CodeSymbolDto`, `CodeImportDto`, `CodeMetricDto`, the analysis
  queue name/payload type), embedding/search DTOs (`EmbeddingRunDto`, `RetrievalResultDto`,
  `SemanticSearchResponse`, the embedding queue name/payload type), AI-analysis DTOs
  (`AIAnalysisRunDto`, `AgentRunDto`, `AIFindingDto`, `AICitationDto`, the AI-analysis queue
  name/payload type), and the AES-256-GCM crypto implementation shared between `apps/api` and
  `apps/worker`.
- `packages/code-analysis` — file classification, ignore rules, and the extension→language map
  (Phase 3); AST parsing (TypeScript/JavaScript via the TypeScript compiler API), heuristic
  parsing (Python/Java/C++/Go), metrics, dependency-graph resolution, and a five-rule
  deterministic rule engine (Phase 4); a deterministic, symbol-boundary-aware chunking engine
  (Phase 5, `src/chunking` — see [semantic-search.md](./semantic-search.md)).
- `packages/ai` — the embedding provider abstraction, RAG context builder, and hybrid retrieval
  (`src/retrieval`, used by both `apps/api`'s search route and `apps/worker`'s AI-analysis
  evidence gathering) (Phase 5); a chat/completion provider abstraction (OpenAI-backed, plus a
  deterministic mock used by every test) and the seven agent specs/prompts/schemas (Phase 6 —
  `src/chat`, `src/agents`) — see [semantic-search.md](./semantic-search.md) and
  [ai-analysis.md](./ai-analysis.md).

No chat UI or autonomous code modification exist, and neither is planned — see
[architecture.md](./architecture.md)'s roadmap for what's in and out of scope. Every Phase 4
finding is deterministic, rule-engine output, never AI-generated;
Phase 5's only model call is the embedding API itself (never interpreted or summarized by another
model); Phase 6's seven agents are the first AI-generated, user-facing content in this codebase —
always structured, Zod-validated, and evidence-cited, never free-form prose trusted blindly. See
[semantic-search.md](./semantic-search.md) and [ai-analysis.md](./ai-analysis.md) for the full
scope boundaries.

Phase 7 (V1 completion & hardening) didn't add new product surface area — it's a correctness pass
over everything above: a stale-run timeout so a crashed worker's job can't block retries forever
(`packages/shared/src/job-staleness.ts`, `STALE_ACTIVE_RUN_MINUTES`, applied in all four
`POST .../ingestions|analyses|embeddings|ai-analysis` routes); a safety cap on the four per-run
history list endpoints, which had no limit; the dashboard's "Engineering Health" card now shows
real aggregate counts instead of stale placeholder copy; the sidebar no longer lists already-built
features ("Analyses", "Findings") as disabled/"coming later"; and this documentation set was
brought back in sync with the real system (removed claims of SSE, a repo-chat assistant, and other
never-built or no-longer-planned features). See the Phase 7 completion report for the full list.

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
  two processes. Phase 4 adds a second, identically-shaped pair: the `code-analysis` queue
  (`apps/api/src/queue.ts`'s `enqueueAnalysisJob`, `apps/worker/src/jobs/analysis-job.ts`). Phase 5
  adds a third: the `embeddings` queue (`enqueueEmbeddingJob`,
  `apps/worker/src/jobs/embedding-job.ts`). Phase 6 adds a fourth: the `ai-analysis` queue
  (`enqueueAIAnalysisJob`, `apps/worker/src/jobs/ai-analysis-job.ts`). `apps/api` also calls the
  OpenAI embeddings API directly (never through the worker) to embed a search query at request
  time — see [semantic-search.md](./semantic-search.md); all seven agents' chat completions, by
  contrast, only ever happen in `apps/worker` — see [ai-analysis.md](./ai-analysis.md).

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
Phase 5 adds `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `CHUNK_TARGET_CHARS`, `CHUNK_MAX_CHARS`,
`CHUNK_OVERLAP_LINES`, `EMBEDDING_BATCH_SIZE` — all have sensible defaults too (see
[semantic-search.md](./semantic-search.md)). Phase 6 adds `OPENAI_MODEL`, `AI_AGENT_CONCURRENCY`,
`AI_AGENT_MAX_RETRIES` — same, all defaulted (see [ai-analysis.md](./ai-analysis.md)).
`OPENAI_API_KEY` stays optional — the whole platform boots and runs without it; only "Index
Repository"/semantic search and "Run AI Analysis" report "not configured" until it's set (the same
key powers both features).

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
packages/code-analysis          file classification (Phase 3); AST/heuristic parsing, symbols, dependency graph, rules (Phase 4); chunking (Phase 5)
packages/ai                      embedding provider + RAG context builder + retrieval (Phase 5); chat provider + seven agent specs (Phase 6)
packages/config                 shared eslint/tsconfig/prettier, not runtime code
```

### A Turbopack quirk worth knowing about

`apps/web`'s production build (`next build`, Turbopack) fails to resolve *value* re-exports
(constants, functions — not types) routed through a workspace package's main barrel
(`packages/shared/src/index.ts`'s `export * from`). Type-only re-exports through the same barrel
are fine, and `apps/api`/`apps/worker` import the barrel's values without issue (they bundle with
tsup/esbuild, not Turbopack). The fix: value exports `apps/web` needs are also exposed as a direct
package subpath (see `packages/shared/package.json`'s `"exports"` map — `/auth`, `/ingestion`,
`/analysis`, `/embedding`, `/ai-analysis`) and imported from there instead of the barrel — see the
comment in `apps/web/src/lib/api.ts`. This came up again in Phase 3 (`isActiveIngestionStatus`),
again in Phase 4 (`isActiveAnalysisStatus`), again in Phase 5 (`isActiveEmbeddingStatus`), and again
in Phase 6 (`isActiveAIAnalysisStatus`), fixed the same way every time.
