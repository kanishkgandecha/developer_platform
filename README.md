# Developer Platform

An AI-powered developer platform that ingests a GitHub repository, indexes it, runs specialized AI
agents over it (architecture, security, code quality, performance, dependencies, documentation),
and surfaces the results as an evidence-backed engineering dashboard with semantic code search.

**Status: V1.** A connected repository is ingested, statically analyzed, semantically indexed, and
run through seven specialized AI agents (Architecture, Code Quality, Security, Performance,
Dependency Risk, Documentation, and an Executive Summary that synthesizes the other six) —
every finding is a structured, Zod-validated, confidence-scored, evidence-cited output grounded
in deterministic code-intelligence data and retrieved code, never a free-form or invented claim.
This is analysis only: no chat, no autonomous code modification, no code execution, no
tool-calling, no GitHub PRs — deliberately, not because those are coming later. See
[docs/architecture.md](docs/architecture.md) for the full system design and
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
- [docs/semantic-search.md](docs/semantic-search.md) — chunking, embeddings, pgvector, hybrid retrieval, RAG context
- [docs/ai-analysis.md](docs/ai-analysis.md) — the seven AI agents, structured output, citations, prompt injection defense
- [docs/deployment.md](docs/deployment.md) — production topology notes
