# Architecture

## Overview

Developer Platform ingests a GitHub repository, indexes it, runs specialized AI agents over it, and
surfaces the results as an evidence-backed engineering dashboard with a RAG-based repo assistant.
This document covers the system as approved for the full build. **Phases 1–4 are implemented**
(foundation, then GitHub OAuth + repository access, then repository ingestion, then deterministic
code intelligence) — see [development.md](./development.md) for what's actually running today,
[authentication.md](./authentication.md) / [github-integration.md](./github-integration.md) for
sign-in and GitHub access, [repository-ingestion.md](./repository-ingestion.md) for how a
repository becomes scanned, classified file metadata, and
[code-intelligence.md](./code-intelligence.md) for how that metadata becomes parsed symbols,
imports, a dependency graph, and deterministic findings.

```
                 ┌────────────┐
   Browser  ───▶ │  apps/web  │  Next.js (App Router) — dashboard, findings UI,
                 │            │  code viewer, architecture graph, chat UI
                 └─────┬──────┘
                        │ REST + SSE
                 ┌─────▼──────┐        ┌──────────────┐
                 │  apps/api  │◀──────▶│  PostgreSQL  │ (+ pgvector)
                 │  Fastify   │        └──────────────┘
                 │  (auth,    │
                 │  REST, SSE)│        ┌──────────────┐
                 └─────┬──────┘◀──────▶│    Redis     │ (queues, cache, sessions)
                        │ enqueue jobs └──────┬───────┘
                 ┌─────▼──────┐               │
                 │apps/worker │◀──────────────┘
                 │ BullMQ     │  ingestion → code analysis → chunk/embed → 7 agents (parallel) → aggregate
                 │ consumers  │
                 └─────┬──────┘
                        │
                 ┌─────▼──────┐        ┌──────────────┐
                 │ GitHub API │        │  OpenAI API  │
                 └────────────┘        └──────────────┘
```

## Why three apps instead of one

Analysis jobs (parsing, embedding, multiple LLM calls) are long-running and must survive
independently of any single HTTP request, which rules out doing everything inside Next.js API
routes / serverless functions. `apps/web` stays a normal Next.js deploy; `apps/api` and
`apps/worker` are plain long-running Node processes. Real-time progress uses Server-Sent Events
(one-directional, rides plain HTTP) rather than WebSockets, since nothing here needs bidirectional
communication.

## Monorepo layout

```
developer-platform/
├── apps/
│   ├── web/               Next.js — dashboard, findings, code viewer, architecture graph, chat
│   ├── api/                 Fastify — auth, REST, SSE progress/chat streaming
│   └── worker/                BullMQ consumers — ingestion, chunking, embedding, agents, aggregation
├── packages/
│   ├── database/             Prisma schema, migrations, generated client
│   ├── ai/                     OpenAI client, agent prompts, Zod schemas, structured-output validation (still empty — Phase 5+)
│   ├── code-analysis/           file classification (Phase 3); AST/heuristic parsing, symbols, imports, dependency graph, deterministic rules (Phase 4)
│   ├── shared/                   shared TS types, Zod DTOs, env schema, AES-256-GCM crypto
│   └── config/                    shared eslint/tsconfig/prettier config
├── docker/                  per-app Dockerfiles
├── docs/
├── tests/                    future cross-app e2e (Playwright)
└── docker-compose.yml
```

Tooling: pnpm workspaces + Turborepo for the task graph/caching. Workspace packages (`shared`,
`database`, `ai`, `code-analysis`) ship as TypeScript source (no separate publish step) — `apps/web`
transpiles them via Next's `transpilePackages`, and `apps/api`/`apps/worker` bundle them via `tsup`
(`noExternal: [/^@developer-platform\//]`), while real npm dependencies stay external.

## Key decisions (full build)

- **Backend framework — Fastify + Zod, not NestJS.** Typed schema validation and a plugin system
  without DI-container ceremony; avoids the over-engineering the project explicitly guards against.
- **Job orchestration — BullMQ `FlowProducer`.** An analysis run is a dependency graph (ingest →
  index → seven agents in parallel → aggregate); FlowProducer models parent/child job trees natively
  instead of a hand-rolled DAG scheduler. `AnalysisJob` rows in Postgres mirror each flow node so the
  progress UI/audit trail don't depend on Redis retention.
- **Repository ingestion — GitHub tarball via API, never `git clone`.** Fetches
  `GET /repos/{owner}/{repo}/tarball/{sha}` (GitHub's API, which redirects to codeload.github.com)
  with the user's token, streams it directly into extraction (never buffered whole), with hard
  caps on entry count/size (zip-bomb protection) and independently re-validated path safety
  (traversal/symlink rejection) — see [repository-ingestion.md](./repository-ingestion.md). No
  `.git` hooks ever execute; no repository code is ever run, anywhere in the pipeline.
- **Phase 4 parsing — the TypeScript compiler API, not tree-sitter, for TS/JS.** Real, native,
  dependency-free (pure JS/TS, no native bindings/Docker build risk) syntax-only parsing
  (`ts.createSourceFile`, no type checking) for the languages that matter most in this stack;
  Python/Java/C++/Go get honest, clearly-labeled heuristic (regex/line-based) extraction instead of
  a "fake AST" — see [code-intelligence.md](./code-intelligence.md) for the full writeup and its
  documented limitations.
- **Embedding chunking (Phase 5+, still future) — tree-sitter AST boundaries with a heuristic
  fallback** for languages without a grammar in the initial set. A distinct concern from Phase 4's
  symbol/import extraction above: this is about splitting file content into embedding-sized chunks,
  not about producing a `CodeSymbol`/`CodeImport` graph.
- **Deterministic vs. LLM-derived data.** Dependency manifests are parsed deterministically into
  `RepositoryDependency`; the Dependency Agent reasons over that real data instead of hallucinating
  package lists or CVEs.
- **Structured output validation.** Every agent response is a Zod schema exposed to OpenAI as a JSON
  Schema; one repair retry is allowed on validation failure, then the job fails outright — nothing
  invalid is ever written to `Finding`/`AgentResult`.
- **Sessions — opaque token + server-side hash, not JWT.** The browser holds a random bearer
  token; Postgres stores only its SHA-256 hash. No GitHub access token ever reaches a JWT payload
  or the browser. See [authentication.md](./authentication.md).
- **Repository rows are per-user, not a global deduplicated table.** Two local users with access
  to the same GitHub repo each get their own `Repository` row, scoped to what *they're* authorized
  to see (`@@unique([userId, githubId])`) — simpler than a shared-entity model, and Phase 2 has no
  use case requiring cross-user dedup yet.

## Database (see [database.md](./database.md) for the full schema)

Implemented so far: `HealthCheck` (Phase 1 placeholder); `User`, `GitHubAccount`, `Session`,
`Repository` (Phase 2); `Ingestion`, `RepositoryFile` (Phase 3 — metadata only, no repository
content); `AnalysisRun`, `CodeSymbol`, `CodeImport`, `DependencyEdge`, `CodeMetric`, `Finding`
(Phase 4 — deterministic code intelligence, extending `RepositoryFile` rather than duplicating file
metadata into a new model). Still to come: `RepositoryDependency`, `CodeChunk` (pgvector embedding),
`AnalysisJob`, `AgentResult`, `ChatSession`, `ChatMessage` — added only in the phases that actually
need them, per this project's own "no premature schema" principle.

## Phased roadmap

1. ✅ **Foundation** — monorepo, Next.js/Fastify/worker skeletons, Postgres+pgvector, Redis,
   Docker Compose, env validation.
2. ✅ **Auth + GitHub OAuth + repository access** — session management, `User`/`GitHubAccount`/
   `Session`/`Repository` models, protected routes, repository listing/sync UI.
3. ✅ **Repository ingestion** — tarball fetch, sandboxed extraction, file classification, an
   ingestion state machine and BullMQ queue, real progress in the UI. See
   [repository-ingestion.md](./repository-ingestion.md).
4. ✅ **Code intelligence** — AST parsing (TypeScript/JavaScript) and heuristic parsing
   (Python/Java/C++/Go), symbol/import extraction, a resolved dependency graph, deterministic
   metrics, and five rule-engine findings — no AI. See
   [code-intelligence.md](./code-intelligence.md).
5. Embeddings + pgvector search (RAG foundation) — tree-sitter-based chunking lands here.
6. Agent framework + Architecture Agent + Security Agent.
7. Remaining five agents (Bug, Code Quality, Testing, Dependency, Documentation).
8. Job system + real-time progress (BullMQ FlowProducer, SSE).
9. Findings UI, code viewer, architecture visualization, repo chat (RAG).
10. Testing, observability, security hardening.
11. Polish — README, docs, demo data, deployment.
