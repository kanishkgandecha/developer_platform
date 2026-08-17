# Developer Platform

An AI-powered developer platform that ingests a GitHub repository, indexes it, runs specialized AI
agents over it (architecture, security, bugs, quality, testing, dependencies, documentation), and
surfaces the results as an evidence-backed engineering dashboard with a RAG-based repo assistant.

**Status: Phase 5 — Semantic Search + RAG Foundation.** A repository that's been ingested and
analyzed can now be semantically indexed and searched: deterministic, symbol-boundary-aware
chunking, batched OpenAI embeddings with content-hash-based incremental re-embedding, pgvector
storage (HNSW, cosine distance), a hybrid semantic+lexical retriever, and a RAG context builder with
source citations — the retrieval layer Phase 6's AI agents will consume. Still no AI agents, no
chat, no LLM-generated summaries anywhere; the only model call in this phase is the embedding API
itself. This sits on top of Phase 4 (code intelligence — parsed symbols, resolved imports, a
dependency graph, deterministic metrics, rule-based findings), Phase 3 (repository ingestion —
tarball retrieval, sandboxed extraction, file classification), Phase 2 (GitHub OAuth sign-in,
sessions, repository access), and Phase 1 (monorepo, web/api/worker, Postgres+pgvector, Redis). The
AI agents themselves land in Phase 6+ — see [docs/architecture.md](docs/architecture.md) for the
full plan and [docs/development.md](docs/development.md) for what's actually implemented today.

## Quick start

```bash
cp .env.example .env
pnpm install
docker compose up --build
```

- Web: http://localhost:3000 (lands on `/login`)
- API health: http://localhost:4000/health

The stack boots and runs fully with the placeholder credentials `.env.example` ships — to actually
sign in with GitHub and ingest a repository, see
[docs/github-integration.md](docs/github-integration.md) for the two-minute OAuth App setup. See
[docs/development.md](docs/development.md) for the full command reference, and
[docs/deployment.md](docs/deployment.md) for production topology notes.

## Documentation

- [docs/architecture.md](docs/architecture.md) — system design and key decisions
- [docs/development.md](docs/development.md) — local setup, commands, package structure
- [docs/database.md](docs/database.md) — schema, migrations, pgvector
- [docs/authentication.md](docs/authentication.md) — OAuth flow, sessions, security
- [docs/github-integration.md](docs/github-integration.md) — GitHub OAuth App setup, scopes, token security
- [docs/repository-ingestion.md](docs/repository-ingestion.md) — ingestion pipeline, security model, limits
- [docs/code-intelligence.md](docs/code-intelligence.md) — parsing, symbols, dependency graph, deterministic rules
- [docs/semantic-search.md](docs/semantic-search.md) — chunking, embeddings, pgvector, hybrid retrieval, RAG context
- [docs/deployment.md](docs/deployment.md) — production topology notes
