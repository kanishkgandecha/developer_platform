# Architecture

## Overview

Developer Platform ingests a GitHub repository, indexes it, and runs specialized AI agents over it,
surfacing the results as an evidence-backed engineering dashboard with semantic code search.
This document covers the system as built. **Phases 1–7 are implemented** (foundation, then GitHub
OAuth + repository access, then repository ingestion, then deterministic code intelligence, then
semantic search + RAG foundation, then the first AI agents, then a V1 completion/hardening pass) —
see [development.md](./development.md) for what's actually running today,
[authentication.md](./authentication.md) / [github-integration.md](./github-integration.md) for
sign-in and GitHub access, [repository-ingestion.md](./repository-ingestion.md) for how a
repository becomes scanned, classified file metadata, [code-intelligence.md](./code-intelligence.md)
for how that metadata becomes parsed symbols, imports, a dependency graph, and deterministic
findings, [semantic-search.md](./semantic-search.md) for how that, in turn, becomes
deterministically chunked, embedded, pgvector-searchable content with a hybrid semantic+lexical
retriever and a RAG context builder, and [ai-analysis.md](./ai-analysis.md) for the seven
specialized agents that interpret all of the above into structured, evidence-cited findings. A chat
interface, autonomous code modification, and a dependency-graph visualization are **deliberately
out of scope for this product** — not a placeholder, not deferred to an implied "next phase"; see
the roadmap below.

```
                 ┌────────────┐
   Browser  ───▶ │  apps/web  │  Next.js (App Router) — dashboard, repositories,
                 │            │  findings, semantic search UI
                 └─────┬──────┘
                        │ REST (client-polled progress, not pushed)
                 ┌─────▼──────┐        ┌──────────────┐
                 │  apps/api  │◀──────▶│  PostgreSQL  │ (+ pgvector)
                 │  Fastify   │        └──────────────┘
                 │  (auth,    │
                 │   REST)    │        ┌──────────────┐
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
`apps/worker` are plain long-running Node processes. Real-time progress is client-side polling
against plain REST endpoints (see each pipeline's `use-*-polling.ts` hook in `apps/web/src/hooks`)
rather than SSE or WebSockets — a deliberate simplification, not a placeholder: every polled value
is the real, current server state.

## Monorepo layout

```
developer-platform/
├── apps/
│   ├── web/               Next.js — dashboard, repositories, findings, semantic search UI
│   ├── api/                 Fastify — auth, REST (client-polled progress)
│   └── worker/                BullMQ consumers — ingestion, chunking, embedding, agents, aggregation
├── packages/
│   ├── database/             Prisma schema, migrations, generated client
│   ├── ai/                     embedding provider + RAG context builder + retrieval (Phase 5); chat provider abstraction + seven agent specs/prompts/schemas (Phase 6)
│   ├── code-analysis/           file classification (Phase 3); AST/heuristic parsing, symbols, imports, dependency graph, deterministic rules (Phase 4); chunking (Phase 5)
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
- **Embedding chunking (Phase 5) — reuse Phase 4's `CodeSymbol` boundaries, not a second
  tree-sitter-based parser.** The original plan sketched here was tree-sitter AST boundaries with a
  heuristic fallback; once Phase 5 actually shipped, reusing the `CodeSymbol`/`startLine`/`endLine`
  data Phase 4 already computes and persists turned out simpler and avoided introducing a second,
  independent set of per-language native-binding grammars purely to re-derive boundaries this
  codebase already has — the same "no native bindings, no native-module Docker build risk" tradeoff
  Phase 4's own parsing decision made. A file with no symbols (or an unsupported language) falls back
  to deterministic line-based chunking. See [semantic-search.md](./semantic-search.md) for the full
  writeup.
- **Vector search — pgvector, cosine distance, HNSW.** `code_chunk.embedding` is a fixed-width
  `vector(1536)` column (`text-embedding-3-small`'s real output size, not guessed), added via raw SQL
  since Prisma's schema language has no native vector type. HNSW over IVFFlat because it needs no
  separate training/list-building step and doesn't degrade as the table grows incrementally — see
  [semantic-search.md](./semantic-search.md).
- **Retrieval — a small deterministic hybrid layer, not a search-ranking framework.** pgvector cosine
  similarity for the candidate pool, re-ranked by a fixed-weight (`0.75`/`0.25`) blend with a simple
  substring-based lexical score, specifically so an exact identifier query (e.g.
  `"PatientDashboard"`) reliably outranks a semantically-close-but-textually-unrelated chunk. See
  [semantic-search.md](./semantic-search.md).
- **Deterministic vs. LLM-derived data.** Every number an agent cites comes from Phase 4/5's
  already-persisted data — a file's line count, a function's complexity, a dependency edge, a
  retrieved code chunk — never from the model recomputing or guessing it; the model's job is
  interpretation, not measurement. See [ai-analysis.md](./ai-analysis.md)'s "core principle"
  section. (A separate, still-future idea — deterministically parsing dependency *manifests*
  (`package.json`/`requirements.txt`/...) into a `RepositoryDependency` model so a future agent
  can reason about outdated packages/CVEs — is not what Phase 6's Dependency Risk agent does; that
  agent reasons over the *code* dependency graph (`DependencyEdge`, Phase 4) already built from
  actual import statements, not package manifests.)
- **Structured output validation — seven agents, one shared schema shape.** Every AI agent
  response (the six primary agents and the executive summary agent) is a Zod schema exposed to
  OpenAI as a JSON Schema (`response_format: zodResponseFormat(...)`); a bounded retry
  (`AI_AGENT_MAX_RETRIES`, default 2) is allowed on a malformed-JSON or schema-invalid response,
  then that one agent (never the whole run) is marked `FAILED` — nothing invalid is ever written
  to `AgentRun`/`AIFinding`. See [ai-analysis.md](./ai-analysis.md).
- **Prompt injection defense — repository content is data, never instructions.** One shared
  guardrail prefix (`AGENT_SYSTEM_GUARDRAILS`) on every agent's system prompt states this
  explicitly; retrieved/deterministic evidence only ever lands in the user-prompt data section,
  proven structurally (not just asked of the model) by
  `packages/ai/src/agents/prompt-injection.test.ts`. See [ai-analysis.md](./ai-analysis.md).
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
metadata into a new model); `EmbeddingRun`, `CodeChunk` (Phase 5 — the first real `vector` column,
extending `AnalysisRun`/`RepositoryFile`/`CodeSymbol` rather than duplicating their metadata);
`AIAnalysisRun`, `AgentRun`, `AIFinding` (Phase 6 — the first AI-generated data in this schema,
extending `AnalysisRun` rather than duplicating its metadata; findings are normalized rows, not one
JSON blob per run). `RepositoryDependency` (a first-class table for the dependency graph, instead of
deriving it from `CodeImport` on every read) is a plausible future addition if a dedicated
architecture-visualization view is ever built — see item 8 below. No `ChatSession`/`ChatMessage`
models exist, and none are planned; this product doesn't have a chat feature (see the Overview).

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
5. ✅ **Semantic search + RAG foundation** — deterministic, symbol-boundary-aware chunking;
   batched OpenAI embeddings with content-hash-based incremental re-embedding; pgvector storage
   (`vector(1536)`, HNSW, cosine distance); a hybrid semantic+lexical retriever; a RAG context
   builder with citations and a character/result budget; a semantic code search UI. No AI agents, no
   chat, no LLM-generated summaries — the retrieval layer Phase 6's agents consume. See
   [semantic-search.md](./semantic-search.md).
6. ✅ **AI code analysis agents** — an AI provider abstraction (OpenAI chat completions + a
   deterministic mock for tests); seven specialized agents (Architecture, Code Quality, Security,
   Performance, Dependency Risk, Documentation, Executive Summary) that interpret Phase 4/5's
   deterministic findings and retrieved code into structured, Zod-validated, evidence-cited
   findings; bounded concurrency/retries; partial-failure tolerance (`COMPLETED_WITH_WARNINGS`); an
   AI Analysis panel and detail UI. No chat, no autonomous code modification, no tool-calling. See
   [ai-analysis.md](./ai-analysis.md).
7. ✅ **Product completion & V1 hardening** — a full audit pass over Phases 1–6: closing reliability
   gaps (e.g. permanently-stuck job recovery), fixing stale/misleading UI copy, bounding previously
   unbounded queries, a security/data-integrity/observability review, and bringing this
   documentation back in sync with the real system. No new product surface area.

V1 is everything above. The following are known, deliberately out-of-scope ideas for a possible
future product direction — not commitments, not "coming soon," and not silently dropped:

8. Dependency-graph visualization (a dedicated UI over the `CodeImport`/`DependencyEdge` data
   Phase 4 already computes).
9. A chat/assistant interface over the RAG retrieval layer Phase 5 already built. Explicitly not
   attempted in V1 (see the Overview) — retrieval-only semantic search is the shipped feature.
10. Deeper observability/CI integrations, if this ever needs to run at a scale where the
    Docker-Compose-local + structured-logs approach stops being enough.
