# Developer Platform

An AI-powered developer platform that ingests a GitHub repository, indexes it, runs specialized AI
agents over it (architecture, security, bugs, quality, testing, dependencies, documentation), and
surfaces the results as an evidence-backed engineering dashboard with a RAG-based repo assistant.

**Status: Phase 4 — Code Intelligence & Static Analysis.** A repository that's been ingested can now
be turned into real code intelligence: parsed symbols, resolved imports, a dependency graph,
deterministic metrics, and rule-based findings — real AST parsing for TypeScript/JavaScript via the
TypeScript compiler API, heuristic extraction for Python/Java/C++/Go. No AI, no LLM calls anywhere
yet. This sits on top of Phase 3 (repository ingestion — tarball retrieval, sandboxed extraction,
file classification), Phase 2 (GitHub OAuth sign-in, sessions, repository access), and Phase 1
(monorepo, web/api/worker, Postgres+pgvector, Redis). Embeddings, RAG, and the AI agents land in
later phases — see [docs/architecture.md](docs/architecture.md) for the full plan and
[docs/development.md](docs/development.md) for what's actually implemented today.

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
- [docs/deployment.md](docs/deployment.md) — production topology notes
